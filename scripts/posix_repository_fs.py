from __future__ import annotations

from contextlib import AbstractContextManager
import hashlib
import os
from pathlib import Path
import secrets
import stat
import time
from typing import Self


_DIRECTORY_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
_FILE_READ_FLAGS = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
_FILE_WRITE_FLAGS = os.O_WRONLY | getattr(os, "O_CLOEXEC", 0)
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


def _fcntl_module():
    import fcntl

    return fcntl


def _relative_path(value: str | Path) -> Path:
    raw_value = os.fspath(value)
    if not isinstance(raw_value, str) or not raw_value or "\0" in raw_value or "\\" in raw_value:
        raise ValueError("repository path must be a simple relative path")
    relative = Path(raw_value)
    if relative.is_absolute() or relative.anchor or not relative.parts:
        raise ValueError("repository path must be a simple relative path")
    if any(part in {"", ".", ".."} or "/" in part for part in relative.parts):
        raise ValueError("repository path must be a simple relative path")
    return relative


def _absolute_path(value: Path) -> Path:
    path = Path(value).absolute()
    if not path.is_absolute() or path.anchor != "/":
        raise ValueError("repository directory must be absolute")
    return path


def _open_directory_at(parent_fd: int, name: str, path: Path, *, create: bool = False, create_new: bool = False) -> int:
    if create:
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent_fd)
        except FileExistsError:
            if create_new:
                raise
    descriptor = os.open(name, _DIRECTORY_FLAGS | _NOFOLLOW, dir_fd=parent_fd)
    try:
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            raise ValueError(f"repository path is not a directory: {path.name}")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _open_directory_chain(path: Path) -> list[int]:
    absolute = _absolute_path(path)
    descriptors = [os.open("/", _DIRECTORY_FLAGS)]
    current = Path("/")
    try:
        for part in absolute.parts[1:]:
            current /= part
            descriptors.append(_open_directory_at(descriptors[-1], part, current))
        return descriptors
    except BaseException:
        _close_all(descriptors)
        raise


def _open_regular_file_at(parent_fd: int, name: str, flags: int, mode: int = 0o600) -> int:
    descriptor = os.open(name, flags | _NOFOLLOW, mode, dir_fd=parent_fd)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("repository path is not a regular file")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _close_all(descriptors: list[int]) -> None:
    first_error: BaseException | None = None
    while descriptors:
        try:
            os.close(descriptors.pop())
        except BaseException as exc:
            if first_error is None:
                first_error = exc
    if first_error is not None:
        raise first_error


def _write_all(descriptor: int, data: bytes) -> None:
    view = memoryview(data)
    offset = 0
    while offset < len(view):
        written = os.write(descriptor, view[offset : offset + 1024 * 1024])
        if written <= 0:
            raise OSError("verified file write made no progress")
        offset += written
    os.fsync(descriptor)


def _verify_named_file(parent_fd: int, name: str, descriptor: int) -> None:
    named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    opened = os.fstat(descriptor)
    if not stat.S_ISREG(named.st_mode) or (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
        raise ValueError("repository file identity changed")


class VerifiedFile(AbstractContextManager["VerifiedFile"]):
    def __init__(self, descriptor: int, directory_descriptors: list[int]) -> None:
        self._descriptor = descriptor
        self._directory_descriptors = directory_descriptors

    def read_bytes(self) -> bytes:
        if self._descriptor is None:
            raise ValueError("verified file is closed")
        os.lseek(self._descriptor, 0, os.SEEK_SET)
        chunks: list[bytes] = []
        while True:
            chunk = os.read(self._descriptor, 1024 * 1024)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)

    def close(self) -> None:
        descriptors, self._directory_descriptors = self._directory_descriptors, []
        if self._descriptor is not None:
            descriptors.append(self._descriptor)
            self._descriptor = None
        _close_all(descriptors)

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.close()


class DirectoryLease(AbstractContextManager["DirectoryLease"]):
    def __init__(self, path: Path, *, protect_parent: bool = True) -> None:
        del protect_parent
        self.path = _absolute_path(path)
        self._handles = _open_directory_chain(self.path)

    def open_file(self, relative_path: str | Path, *, protect_from_rename: bool = False) -> VerifiedFile:
        del protect_from_rename
        relative = _relative_path(relative_path)
        directories: list[int] = []
        parent_fd = self._handles[-1]
        current = self.path
        try:
            for part in relative.parts[:-1]:
                current /= part
                descriptor = _open_directory_at(parent_fd, part, current)
                directories.append(descriptor)
                parent_fd = descriptor
            descriptor = _open_regular_file_at(parent_fd, relative.parts[-1], _FILE_READ_FLAGS)
            return VerifiedFile(descriptor, directories)
        except BaseException:
            _close_all(directories)
            raise

    @classmethod
    def _from_verified_handles(cls, path: Path, handles: list[int]) -> "DirectoryLease":
        lease = cls.__new__(cls)
        lease.path = _absolute_path(path)
        lease._handles = handles
        return lease

    def close(self) -> None:
        handles, self._handles = self._handles, []
        _close_all(handles)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.close()


class SafeFileOperationError(OSError):
    def __init__(self, message: str, *, residual_paths: tuple[Path, ...]) -> None:
        super().__init__(message)
        self.residual_paths = residual_paths


def publish_new_file_safely(directory_lease: DirectoryLease, relative_path: str | Path, data: bytes) -> None:
    relative = _relative_path(relative_path)
    if len(relative.parts) != 1:
        raise ValueError("safe publication target must be directly inside the leased directory")
    parent_fd = directory_lease._handles[-1]
    target_name = relative.parts[0]
    temporary_name = f".{target_name}.{secrets.token_hex(8)}.tmp"
    descriptor = _open_regular_file_at(
        parent_fd,
        temporary_name,
        _FILE_WRITE_FLAGS | os.O_CREAT | os.O_EXCL,
    )
    linked = False
    failure: BaseException | None = None
    try:
        _write_all(descriptor, bytes(data))
        os.link(
            temporary_name,
            target_name,
            src_dir_fd=parent_fd,
            dst_dir_fd=parent_fd,
            follow_symlinks=False,
        )
        linked = True
        os.unlink(temporary_name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    except BaseException as exc:
        failure = exc
        try:
            os.unlink(temporary_name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        except BaseException as cleanup_exc:
            residual = directory_lease.path / temporary_name
            failure = SafeFileOperationError(
                f"safe publication failed and left a temporary file: {residual}",
                residual_paths=(residual,),
            )
            failure.__cause__ = cleanup_exc
    finally:
        try:
            os.close(descriptor)
        except BaseException as close_exc:
            residual = directory_lease.path / (target_name if linked else temporary_name)
            failure = SafeFileOperationError(
                f"safe publication could not close its file descriptor: {residual}",
                residual_paths=(residual,),
            )
            failure.__cause__ = close_exc
    if failure is not None:
        raise failure


def delete_file_safely(directory_lease: DirectoryLease, relative_path: str | Path) -> None:
    relative = _relative_path(relative_path)
    if len(relative.parts) != 1:
        raise ValueError("safe deletion target must be directly inside the leased directory")
    parent_fd = directory_lease._handles[-1]
    name = relative.parts[0]
    descriptor = _open_regular_file_at(parent_fd, name, _FILE_READ_FLAGS)
    try:
        _verify_named_file(parent_fd, name, descriptor)
        os.unlink(name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        os.close(descriptor)


def ensure_directory_tree_safely(project_root: Path, target: Path) -> DirectoryLease:
    root = _absolute_path(project_root)
    destination = _absolute_path(target)
    try:
        relative = destination.relative_to(root)
    except ValueError as exc:
        raise ValueError("repository directory must be inside the project root") from exc
    if not relative.parts:
        raise ValueError("repository directory must be a strict descendant of the project root")

    root_lease = DirectoryLease(root)
    handles, root_lease._handles = root_lease._handles, []
    parent_fd = handles[-1]
    current = root
    try:
        for part in relative.parts:
            current /= part
            descriptor = _open_directory_at(parent_fd, part, current, create=True)
            handles.append(descriptor)
            parent_fd = descriptor
        return DirectoryLease._from_verified_handles(destination, handles)
    except BaseException:
        _close_all(handles)
        raise


class RepositoryLock(AbstractContextManager["RepositoryLock"]):
    def __init__(self, repository: Path, *, timeout: float = 10.0, poll_interval: float = 0.01) -> None:
        if timeout < 0 or poll_interval <= 0:
            raise ValueError("lock timeout must be non-negative and poll interval must be positive")
        self.repository = _absolute_path(repository)
        self.timeout = timeout
        self.poll_interval = poll_interval
        self._lease: DirectoryLease | None = None
        self._handle: int | None = None

    def acquire(self) -> Self:
        if self._handle is not None:
            raise RuntimeError("repository lock is already acquired")
        lease = DirectoryLease(self.repository)
        descriptor = _open_regular_file_at(
            lease._handles[-1],
            ".repository.lock",
            os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0),
        )
        try:
            _acquire_lock(descriptor, self.timeout, self.poll_interval, "repository is locked by another image task")
            self._lease = lease
            self._handle = descriptor
            return self
        except BaseException:
            os.close(descriptor)
            lease.close()
            raise

    def release(self) -> None:
        if self._handle is None:
            return
        descriptor, self._handle = self._handle, None
        lease, self._lease = self._lease, None
        first_error: BaseException | None = None
        try:
            _fcntl_module().flock(descriptor, _fcntl_module().LOCK_UN)
        except BaseException as exc:
            first_error = exc
        try:
            os.close(descriptor)
        except BaseException as exc:
            if first_error is None:
                first_error = exc
        try:
            lease.close()
        except BaseException as exc:
            if first_error is None:
                first_error = exc
        if first_error is not None:
            raise first_error

    def __enter__(self) -> Self:
        return self.acquire()

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.release()


def _acquire_lock(descriptor: int, timeout: float, poll_interval: float, message: str) -> None:
    fcntl = _fcntl_module()
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError as exc:
            if time.monotonic() >= deadline:
                raise TimeoutError(message) from exc
            time.sleep(min(poll_interval, max(0, deadline - time.monotonic())))


class SubmissionLock(AbstractContextManager["SubmissionLock"]):
    def __init__(
        self,
        repository: Path,
        submission_id: str,
        *,
        timeout: float = 610.0,
        poll_interval: float = 0.01,
    ) -> None:
        if timeout < 0 or poll_interval <= 0:
            raise ValueError("lock timeout must be non-negative and poll interval must be positive")
        if len(submission_id) != 36 or not submission_id.startswith("sub_"):
            raise ValueError("invalid submission ID")
        try:
            int(submission_id[4:], 16)
        except ValueError as exc:
            raise ValueError("invalid submission ID") from exc
        self.repository = _absolute_path(repository)
        self.submission_id = submission_id
        self.timeout = timeout
        self.poll_interval = poll_interval
        self._offset = int.from_bytes(hashlib.sha256(submission_id.encode("ascii")).digest()[:8], "little") % ((1 << 63) - 1)
        self._lease: DirectoryLease | None = None
        self._handle: int | None = None

    def acquire(self) -> Self:
        if self._handle is not None:
            raise RuntimeError("submission lock is already acquired")
        lease = DirectoryLease(self.repository)
        descriptor = _open_regular_file_at(
            lease._handles[-1],
            ".submission.lock",
            os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0),
        )
        fcntl = _fcntl_module()
        deadline = time.monotonic() + self.timeout
        try:
            while True:
                try:
                    fcntl.lockf(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB, 1, self._offset, os.SEEK_SET)
                    self._lease = lease
                    self._handle = descriptor
                    return self
                except BlockingIOError as exc:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("edit submission is still in progress") from exc
                    time.sleep(min(self.poll_interval, max(0, deadline - time.monotonic())))
        except BaseException:
            os.close(descriptor)
            lease.close()
            raise

    def release(self) -> None:
        if self._handle is None:
            return
        descriptor, self._handle = self._handle, None
        lease, self._lease = self._lease, None
        first_error: BaseException | None = None
        try:
            _fcntl_module().lockf(descriptor, _fcntl_module().LOCK_UN, 1, self._offset, os.SEEK_SET)
        except BaseException as exc:
            first_error = exc
        try:
            os.close(descriptor)
        except BaseException as exc:
            if first_error is None:
                first_error = exc
        try:
            lease.close()
        except BaseException as exc:
            if first_error is None:
                first_error = exc
        if first_error is not None:
            raise first_error

    def __enter__(self) -> Self:
        return self.acquire()

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.release()


class RepositoryMutation(AbstractContextManager["RepositoryMutation"]):
    def __init__(self, repository: Path, *, timeout: float = 10.0) -> None:
        self.repository = _absolute_path(repository)
        self._lock = RepositoryLock(self.repository, timeout=timeout)
        self._directory_handles: dict[tuple[str, ...], int] = {}

    def _directory_fd(self, relative: Path, *, create: bool) -> int:
        parent_fd = self._lock._lease._handles[-1]
        current = self.repository
        parts: list[str] = []
        for part in relative.parts:
            parts.append(part)
            key = tuple(parts)
            current /= part
            if key not in self._directory_handles:
                self._directory_handles[key] = _open_directory_at(parent_fd, part, current, create=create)
            parent_fd = self._directory_handles[key]
        return parent_fd

    def create_directory(self, relative_path: str | Path) -> None:
        self._directory_fd(_relative_path(relative_path), create=True)

    def create_new_directory(self, relative_path: str | Path) -> None:
        relative = _relative_path(relative_path)
        parent_fd = self._directory_fd(relative.parent, create=True) if relative.parent.parts else self._lock._lease._handles[-1]
        target = self.repository / relative
        key = tuple(relative.parts)
        self._directory_handles[key] = _open_directory_at(
            parent_fd,
            relative.parts[-1],
            target,
            create=True,
            create_new=True,
        )
        os.fsync(parent_fd)

    def _parent_fd(self, relative: Path) -> int:
        if not relative.parent.parts:
            return self._lock._lease._handles[-1]
        return self._directory_fd(relative.parent, create=False)

    def open_file(self, relative_path: str | Path, *, protect_from_rename: bool = False) -> VerifiedFile:
        del protect_from_rename
        relative = _relative_path(relative_path)
        descriptor = _open_regular_file_at(self._parent_fd(relative), relative.parts[-1], _FILE_READ_FLAGS)
        return VerifiedFile(descriptor, [])

    def publish_new_file(self, relative_path: str | Path, data: bytes) -> None:
        relative = _relative_path(relative_path)
        parent_fd = self._parent_fd(relative)
        descriptor = _open_regular_file_at(
            parent_fd,
            relative.parts[-1],
            _FILE_WRITE_FLAGS | os.O_CREAT | os.O_EXCL,
        )
        try:
            _write_all(descriptor, bytes(data))
        finally:
            os.close(descriptor)
        os.fsync(parent_fd)

    def publish_replace_file(self, relative_path: str | Path, data: bytes) -> None:
        relative = _relative_path(relative_path)
        parent_fd = self._parent_fd(relative)
        target_name = relative.parts[-1]
        temporary_name = f".{target_name}.{secrets.token_hex(8)}.tmp"
        descriptor = _open_regular_file_at(
            parent_fd,
            temporary_name,
            _FILE_WRITE_FLAGS | os.O_CREAT | os.O_EXCL,
        )
        published = False
        try:
            _write_all(descriptor, bytes(data))
            try:
                metadata = os.stat(target_name, dir_fd=parent_fd, follow_symlinks=False)
                if not stat.S_ISREG(metadata.st_mode):
                    raise ValueError("repository path is not a regular file")
            except FileNotFoundError:
                pass
            os.replace(temporary_name, target_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            os.fsync(parent_fd)
            published = True
        finally:
            os.close(descriptor)
            if not published:
                try:
                    os.unlink(temporary_name, dir_fd=parent_fd)
                except FileNotFoundError:
                    pass

    def remove_directory_if_known(self, relative_path: str | Path, known_files: set[str]) -> None:
        relative = _relative_path(relative_path)
        parent_fd = self._parent_fd(relative)
        key = tuple(relative.parts)
        directory_fd = self._directory_handles.pop(key, None)
        if directory_fd is None:
            directory_fd = _open_directory_at(parent_fd, relative.parts[-1], self.repository / relative)
        try:
            entry_names = set(os.listdir(directory_fd))
            if not entry_names.issubset(set(known_files)):
                raise OSError("repository directory contains unknown entries")
            for name in entry_names:
                metadata = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if not stat.S_ISREG(metadata.st_mode):
                    raise OSError("repository directory contains unknown entries")
                os.unlink(name, dir_fd=directory_fd)
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        os.rmdir(relative.parts[-1], dir_fd=parent_fd)
        os.fsync(parent_fd)

    def __enter__(self) -> Self:
        self._lock.acquire()
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        descriptors = list(self._directory_handles.values())
        self._directory_handles.clear()
        first_error: BaseException | None = None
        try:
            _close_all(descriptors)
        except BaseException as exc:
            first_error = exc
        try:
            self._lock.release()
        except BaseException as exc:
            if first_error is None:
                first_error = exc
        if first_error is not None:
            raise first_error
