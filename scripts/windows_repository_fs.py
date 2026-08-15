from __future__ import annotations

from contextlib import AbstractContextManager
import ctypes
from ctypes import wintypes
import hashlib
import os
from pathlib import Path
import re
import secrets
import stat
import time
from typing import Self


if os.name != "nt":
    raise RuntimeError("windows_repository_fs is only available on Windows")


GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_READ_ATTRIBUTES = 0x00000080
FILE_LIST_DIRECTORY = 0x00000001
DELETE = 0x00010000
FILE_SHARE_READ = 0x00000001
FILE_SHARE_WRITE = 0x00000002
FILE_SHARE_DELETE = 0x00000004
OPEN_EXISTING = 3
OPEN_ALWAYS = 4
CREATE_NEW = 1
FILE_ATTRIBUTE_NORMAL = 0x00000080
FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
FILE_TYPE_DISK = 0x0001
LOCKFILE_FAIL_IMMEDIATELY = 0x00000001
LOCKFILE_EXCLUSIVE_LOCK = 0x00000002
ERROR_LOCK_VIOLATION = 33
ERROR_SHARING_VIOLATION = 32
FILE_ATTRIBUTE_TAG_INFO_CLASS = 9
FILE_RENAME_INFO_CLASS = 3
FILE_DISPOSITION_INFO_CLASS = 4
SYNCHRONIZE = 0x00100000
OBJ_CASE_INSENSITIVE = 0x00000040
OBJ_DONT_REPARSE = 0x00001000
FILE_OPEN = 1
FILE_CREATE = 2
FILE_OPEN_IF = 3
FILE_DIRECTORY_FILE = 0x00000001
FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class _FileAttributeTagInfo(ctypes.Structure):
    _fields_ = [("file_attributes", wintypes.DWORD), ("reparse_tag", wintypes.DWORD)]


class _Overlapped(ctypes.Structure):
    _fields_ = [
        ("internal", ctypes.c_size_t),
        ("internal_high", ctypes.c_size_t),
        ("offset", wintypes.DWORD),
        ("offset_high", wintypes.DWORD),
        ("event", wintypes.HANDLE),
    ]


class _FileRenameInfo(ctypes.Structure):
    _pack_ = 8
    _fields_ = [
        ("replace_if_exists", wintypes.BOOL),
        ("root_directory", wintypes.HANDLE),
        ("file_name_length", wintypes.DWORD),
        ("file_name", ctypes.c_wchar * 1),
    ]


class _FileDispositionInfo(ctypes.Structure):
    _fields_ = [("delete_file", wintypes.BOOL)]


class _UnicodeString(ctypes.Structure):
    _fields_ = [
        ("length", wintypes.USHORT),
        ("maximum_length", wintypes.USHORT),
        ("buffer", wintypes.LPWSTR),
    ]


class _ObjectAttributes(ctypes.Structure):
    _fields_ = [
        ("length", wintypes.ULONG),
        ("root_directory", wintypes.HANDLE),
        ("object_name", ctypes.POINTER(_UnicodeString)),
        ("attributes", wintypes.ULONG),
        ("security_descriptor", wintypes.LPVOID),
        ("security_quality_of_service", wintypes.LPVOID),
    ]


class _IoStatusBlock(ctypes.Structure):
    _fields_ = [("status", ctypes.c_ssize_t), ("information", ctypes.c_size_t)]


_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_create_file = _kernel32.CreateFileW
_create_file.argtypes = [
    wintypes.LPCWSTR,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.LPVOID,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.HANDLE,
]
_create_file.restype = wintypes.HANDLE
_close_handle = _kernel32.CloseHandle
_close_handle.argtypes = [wintypes.HANDLE]
_close_handle.restype = wintypes.BOOL
_get_file_information = _kernel32.GetFileInformationByHandleEx
_get_file_information.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
_get_file_information.restype = wintypes.BOOL
_get_file_type = _kernel32.GetFileType
_get_file_type.argtypes = [wintypes.HANDLE]
_get_file_type.restype = wintypes.DWORD
_set_file_information = _kernel32.SetFileInformationByHandle
_set_file_information.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
_set_file_information.restype = wintypes.BOOL
_get_file_size = _kernel32.GetFileSizeEx
_get_file_size.argtypes = [wintypes.HANDLE, ctypes.POINTER(ctypes.c_longlong)]
_get_file_size.restype = wintypes.BOOL
_set_file_pointer = _kernel32.SetFilePointerEx
_set_file_pointer.argtypes = [wintypes.HANDLE, ctypes.c_longlong, ctypes.c_void_p, wintypes.DWORD]
_set_file_pointer.restype = wintypes.BOOL
_read_file = _kernel32.ReadFile
_read_file.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
_read_file.restype = wintypes.BOOL
_write_file = _kernel32.WriteFile
_write_file.argtypes = [wintypes.HANDLE, wintypes.LPCVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
_write_file.restype = wintypes.BOOL
_flush_file_buffers = _kernel32.FlushFileBuffers
_flush_file_buffers.argtypes = [wintypes.HANDLE]
_flush_file_buffers.restype = wintypes.BOOL
_lock_file = _kernel32.LockFileEx
_lock_file.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(_Overlapped)]
_lock_file.restype = wintypes.BOOL
_unlock_file = _kernel32.UnlockFileEx
_unlock_file.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(_Overlapped)]
_unlock_file.restype = wintypes.BOOL
_nt_create_file = ctypes.WinDLL("ntdll", use_last_error=True).NtCreateFile
_nt_create_file.argtypes = [
    ctypes.POINTER(wintypes.HANDLE),
    wintypes.DWORD,
    ctypes.POINTER(_ObjectAttributes),
    ctypes.POINTER(_IoStatusBlock),
    ctypes.POINTER(ctypes.c_longlong),
    wintypes.ULONG,
    wintypes.ULONG,
    wintypes.ULONG,
    wintypes.ULONG,
    wintypes.LPVOID,
    wintypes.ULONG,
]
_nt_create_file.restype = ctypes.c_long
_rtl_nt_status_to_dos_error = ctypes.WinDLL("ntdll").RtlNtStatusToDosError
_rtl_nt_status_to_dos_error.argtypes = [ctypes.c_long]
_rtl_nt_status_to_dos_error.restype = wintypes.ULONG


def _raise_last_error(path: Path) -> None:
    error = ctypes.get_last_error()
    raise OSError(error, ctypes.FormatError(error), str(path))


def _close(handle: int) -> None:
    if not _close_handle(handle):
        _raise_last_error(Path("<handle>"))


def _close_all(handles: list[int]) -> None:
    first_error: BaseException | None = None
    while handles:
        try:
            _close(handles.pop())
        except BaseException as exc:
            if first_error is None:
                first_error = exc
    if first_error is not None:
        raise first_error


def _open_handle(
    path: Path,
    *,
    directory: bool,
    disposition: int = OPEN_EXISTING,
    protect_from_rename: bool = False,
    delete_access: bool = False,
    shared_lock: bool = False,
) -> int:
    flags = FILE_FLAG_OPEN_REPARSE_POINT
    access = GENERIC_READ
    share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
    if directory:
        flags |= FILE_FLAG_BACKUP_SEMANTICS
        access = FILE_LIST_DIRECTORY
        share = FILE_SHARE_READ | FILE_SHARE_WRITE
        if not protect_from_rename:
            share |= FILE_SHARE_DELETE
    elif disposition == OPEN_EXISTING:
        share = FILE_SHARE_READ | FILE_SHARE_DELETE
        if protect_from_rename:
            share &= ~FILE_SHARE_DELETE
    elif disposition == OPEN_ALWAYS:
        access = GENERIC_READ | GENERIC_WRITE
        if not shared_lock:
            access |= DELETE
        share = FILE_SHARE_READ | FILE_SHARE_WRITE
        flags |= FILE_ATTRIBUTE_NORMAL
    elif disposition == CREATE_NEW:
        access = GENERIC_READ | GENERIC_WRITE | DELETE
        share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
        flags |= FILE_ATTRIBUTE_NORMAL
    if delete_access:
        access |= DELETE
        share &= ~FILE_SHARE_DELETE
    handle = _create_file(str(path), access, share, None, disposition, flags, None)
    if handle == INVALID_HANDLE_VALUE:
        _raise_last_error(path)
    try:
        info = _FileAttributeTagInfo()
        if not _get_file_information(handle, FILE_ATTRIBUTE_TAG_INFO_CLASS, ctypes.byref(info), ctypes.sizeof(info)):
            _raise_last_error(path)
        if info.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError(f"repository path contains a reparse point: {path.name}")
        is_directory = bool(info.file_attributes & 0x10)
        if is_directory != directory:
            expected = "directory" if directory else "file"
            raise ValueError(f"repository path is not a {expected}: {path.name}")
        if not directory and _get_file_type(handle) != FILE_TYPE_DISK:
            raise ValueError(f"repository path is not a disk file: {path.name}")
        return handle
    except BaseException:
        _close(handle)
        raise


def _open_directory_relative(
    parent_handle: int,
    name: str,
    path: Path,
    *,
    create: bool,
    create_new: bool = False,
    delete_access: bool = False,
) -> int:
    name_buffer = ctypes.create_unicode_buffer(name)
    object_name = _UnicodeString(
        len(name.encode("utf-16-le")),
        len(name_buffer) * 2,
        ctypes.cast(name_buffer, wintypes.LPWSTR),
    )
    attributes = _ObjectAttributes(
        ctypes.sizeof(_ObjectAttributes),
        parent_handle,
        ctypes.pointer(object_name),
        OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        None,
        None,
    )
    io_status = _IoStatusBlock()
    handle = wintypes.HANDLE()
    access = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE
    if delete_access:
        access |= DELETE
    disposition = FILE_CREATE if create_new else FILE_OPEN_IF if create else FILE_OPEN
    status = _nt_create_file(
        ctypes.byref(handle),
        access,
        ctypes.byref(attributes),
        ctypes.byref(io_status),
        None,
        FILE_ATTRIBUTE_NORMAL,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        disposition,
        FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_FLAG_OPEN_REPARSE_POINT,
        None,
        0,
    )
    if status < 0:
        error = _rtl_nt_status_to_dos_error(status)
        raise OSError(error, ctypes.FormatError(error), str(path))
    raw_handle = handle.value
    try:
        info = _FileAttributeTagInfo()
        if not _get_file_information(raw_handle, FILE_ATTRIBUTE_TAG_INFO_CLASS, ctypes.byref(info), ctypes.sizeof(info)):
            _raise_last_error(path)
        if info.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError(f"repository path contains a reparse point: {path.name}")
        if not info.file_attributes & 0x10:
            raise ValueError(f"repository path is not a directory: {path.name}")
        return raw_handle
    except BaseException:
        _close(raw_handle)
        raise


def _directory_chain(path: Path) -> list[Path]:
    absolute = Path(path).absolute()
    if not absolute.anchor:
        raise ValueError("repository directory must be absolute")
    chain = [Path(absolute.anchor)]
    current = chain[0]
    for part in absolute.parts[1:]:
        current = current / part
        chain.append(current)
    return chain


def _relative_path(value: str | Path) -> Path:
    raw_value = os.fspath(value)
    if not isinstance(raw_value, str) or not raw_value:
        raise ValueError("repository path must be a simple relative path")
    raw_parts = re.split(r"[\\/]", raw_value)
    reserved = {
        "CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$",
        *(f"COM{index}" for index in range(1, 10)),
        *(f"LPT{index}" for index in range(1, 10)),
        "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³",
    }
    if any(part in {"", ".", ".."} for part in raw_parts):
        raise ValueError("repository path must be a simple relative path")
    for part in raw_parts:
        normalized = part.rstrip(" .")
        stem = normalized.split(".", 1)[0].rstrip(" ").upper()
        if (
            ":" in part
            or part.endswith((" ", "."))
            or stem in reserved
            or any(ord(character) < 32 for character in part)
            or any(character in '<>"|?*' for character in part)
        ):
            raise ValueError("repository path must be a simple relative path")
    relative = Path(raw_value)
    if relative.drive or relative.root or relative.anchor or relative.is_absolute() or not relative.parts:
        raise ValueError("repository path must be a simple relative path")
    for part in relative.parts:
        if (
            part in {"", ".", ".."}
            or ":" in part
            or part.endswith((" ", "."))
        ):
            raise ValueError("repository path must be a simple relative path")
    return relative


def _reject_reparse_path(path: Path, repository: Path) -> None:
    current = Path(repository).absolute()
    target = Path(path).absolute()
    try:
        relative = target.relative_to(current)
    except ValueError as exc:
        raise ValueError("repository path escapes its root") from exc
    for part in relative.parts:
        current = current / part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        if metadata.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError(f"repository path contains a reparse point: {current.name}")


def _write_all(handle: int, data: bytes) -> None:
    view = memoryview(data)
    offset = 0
    while offset < len(view):
        chunk = bytes(view[offset : offset + 1024 * 1024])
        written = wintypes.DWORD()
        buffer = ctypes.create_string_buffer(chunk)
        if not _write_file(handle, buffer, len(chunk), ctypes.byref(written), None):
            _raise_last_error(Path("<verified file>"))
        if written.value == 0:
            raise OSError("verified file write made no progress")
        offset += written.value
    if not _flush_file_buffers(handle):
        _raise_last_error(Path("<verified file>"))


def _replace_file_by_handle(
    source_handle: int,
    source_path: Path,
    target_path: Path,
    *,
    replace_if_exists: bool = True,
) -> None:
    del source_path
    try:
        existing_handle = _open_handle(target_path, directory=False)
    except FileNotFoundError:
        existing_handle = None
    if existing_handle is not None:
        _close(existing_handle)
    encoded_name = (str(target_path) + "\0").encode("utf-16-le")
    name_offset = _FileRenameInfo.file_name.offset
    buffer = ctypes.create_string_buffer(name_offset + len(encoded_name))
    info = ctypes.cast(buffer, ctypes.POINTER(_FileRenameInfo)).contents
    info.replace_if_exists = replace_if_exists
    info.root_directory = None
    info.file_name_length = len(encoded_name) - 2
    ctypes.memmove(ctypes.addressof(buffer) + name_offset, encoded_name, len(encoded_name))
    if not _set_file_information(source_handle, FILE_RENAME_INFO_CLASS, buffer, len(buffer)):
        _raise_last_error(target_path)


def _delete_file_by_handle(handle: int, path: Path) -> None:
    info = _FileDispositionInfo(True)
    if not _set_file_information(
        handle,
        FILE_DISPOSITION_INFO_CLASS,
        ctypes.byref(info),
        ctypes.sizeof(info),
    ):
        _raise_last_error(path)


class VerifiedFile(AbstractContextManager["VerifiedFile"]):
    def __init__(self, handle: int, directory_handles: list[int]) -> None:
        self._handle = handle
        self._directory_handles = directory_handles

    def read_bytes(self) -> bytes:
        if self._handle is None:
            raise ValueError("verified file is closed")
        size = ctypes.c_longlong()
        if not _get_file_size(self._handle, ctypes.byref(size)):
            _raise_last_error(Path("<verified file>"))
        if not _set_file_pointer(self._handle, 0, None, 0):
            _raise_last_error(Path("<verified file>"))
        remaining = size.value
        chunks: list[bytes] = []
        while remaining:
            chunk_size = min(remaining, 1024 * 1024)
            buffer = ctypes.create_string_buffer(chunk_size)
            read = wintypes.DWORD()
            if not _read_file(self._handle, buffer, chunk_size, ctypes.byref(read), None):
                _raise_last_error(Path("<verified file>"))
            if read.value == 0:
                raise OSError("verified file ended before its reported size")
            chunks.append(buffer.raw[: read.value])
            remaining -= read.value
        return b"".join(chunks)

    def close(self) -> None:
        handles = self._directory_handles
        self._directory_handles = []
        if self._handle is not None:
            handles.append(self._handle)
            self._handle = None
        _close_all(handles)

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.close()


class DirectoryLease(AbstractContextManager["DirectoryLease"]):
    def __init__(self, path: Path, *, protect_parent: bool = True) -> None:
        self.path = Path(path).absolute()
        self._handles: list[int] = []
        try:
            chain = _directory_chain(self.path)
            protected_start = 0 if protect_parent else max(0, len(chain) - 1)
            for index, segment in enumerate(chain):
                self._handles.append(
                    _open_handle(segment, directory=True, protect_from_rename=index >= protected_start)
                )
        except BaseException:
            self.close()
            raise

    def open_file(self, relative_path: str | Path, *, protect_from_rename: bool = False) -> VerifiedFile:
        relative = _relative_path(relative_path)
        directory_handles: list[int] = []
        current = self.path
        try:
            for part in relative.parts[:-1]:
                current = current / part
                directory_handles.append(
                    _open_handle(current, directory=True, protect_from_rename=True)
                )
            handle = _open_handle(
                current / relative.parts[-1],
                directory=False,
                protect_from_rename=protect_from_rename,
            )
            return VerifiedFile(handle, directory_handles)
        except BaseException:
            while directory_handles:
                _close(directory_handles.pop())
            raise

    @classmethod
    def _from_verified_handles(cls, path: Path, handles: list[int]) -> "DirectoryLease":
        lease = cls.__new__(cls)
        lease.path = Path(path).absolute()
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


def publish_new_file_safely(
    directory_lease: DirectoryLease,
    relative_path: str | Path,
    data: bytes,
) -> None:
    relative = _relative_path(relative_path)
    if len(relative.parts) != 1:
        raise ValueError("safe publication target must be directly inside the leased directory")
    target = directory_lease.path / relative
    temporary = target.with_name(f".{target.name}.{secrets.token_hex(8)}.tmp")
    handle = _open_handle(temporary, directory=False, disposition=CREATE_NEW)
    published = False
    failure: BaseException | None = None
    try:
        _write_all(handle, bytes(data))
        _replace_file_by_handle(handle, temporary, target, replace_if_exists=False)
        published = True
    except BaseException as exc:
        failure = exc
        if not published:
            try:
                _delete_file_by_handle(handle, temporary)
            except BaseException as cleanup_exc:
                failure = SafeFileOperationError(
                    f"safe publication failed and left a temporary file: {temporary}",
                    residual_paths=(temporary,),
                )
                failure.__cause__ = cleanup_exc
    try:
        _close(handle)
    except BaseException as close_exc:
        residual = target if published else temporary
        failure = SafeFileOperationError(
            f"safe publication could not close its file handle: {residual}",
            residual_paths=(residual,),
        )
        failure.__cause__ = close_exc
    if failure is not None:
        raise failure


def delete_file_safely(directory_lease: DirectoryLease, relative_path: str | Path) -> None:
    relative = _relative_path(relative_path)
    if len(relative.parts) != 1:
        raise ValueError("safe deletion target must be directly inside the leased directory")
    target = directory_lease.path / relative
    handle = _open_handle(
        target,
        directory=False,
        protect_from_rename=True,
        delete_access=True,
    )
    failure: BaseException | None = None
    try:
        _delete_file_by_handle(handle, target)
    except BaseException as exc:
        failure = exc
    try:
        _close(handle)
    except BaseException as close_exc:
        if failure is None:
            failure = close_exc
    if failure is not None:
        raise failure


def ensure_directory_tree_safely(project_root: Path, target: Path) -> DirectoryLease:
    root = Path(project_root).absolute()
    destination = Path(target).absolute()
    try:
        relative = destination.relative_to(root)
    except ValueError as exc:
        raise ValueError("repository directory must be inside the project root") from exc
    if not relative.parts:
        raise ValueError("repository directory must be a strict descendant of the project root")

    root_lease = DirectoryLease(root)
    handles = root_lease._handles
    root_lease._handles = []
    current = root
    try:
        parent_handle = handles[-1]
        for part in relative.parts:
            current = current / part
            child_handle = _open_directory_relative(
                parent_handle,
                part,
                current,
                create=True,
            )
            handles.append(child_handle)
            parent_handle = child_handle
        return DirectoryLease._from_verified_handles(destination, handles)
    except BaseException:
        _close_all(handles)
        raise


class RepositoryLock(AbstractContextManager["RepositoryLock"]):
    def __init__(self, repository: Path, *, timeout: float = 10.0, poll_interval: float = 0.01) -> None:
        if timeout < 0 or poll_interval <= 0:
            raise ValueError("lock timeout must be non-negative and poll interval must be positive")
        self.repository = Path(repository).absolute()
        self.timeout = timeout
        self.poll_interval = poll_interval
        self._lease: DirectoryLease | None = None
        self._parent_lease: DirectoryLease | None = None
        self._handle: int | None = None
        self._overlapped: _Overlapped | None = None

    def acquire(self) -> Self:
        if self._handle is not None:
            raise RuntimeError("repository lock is already acquired")
        deadline = time.monotonic() + self.timeout
        lease = DirectoryLease(self.repository)
        try:
            while True:
                try:
                    handle = _open_handle(self.repository / ".repository.lock", directory=False, disposition=OPEN_ALWAYS)
                    break
                except OSError as exc:
                    if exc.errno != ERROR_SHARING_VIOLATION:
                        raise
                    if time.monotonic() >= deadline:
                        raise TimeoutError("repository is locked by another image task") from exc
                    time.sleep(min(self.poll_interval, max(0, deadline - time.monotonic())))
            overlapped = _Overlapped()
            while not _lock_file(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, ctypes.byref(overlapped)):
                error = ctypes.get_last_error()
                if error != ERROR_LOCK_VIOLATION:
                    raise OSError(error, ctypes.FormatError(error), str(self.repository / ".repository.lock"))
                if time.monotonic() >= deadline:
                    raise TimeoutError("repository is locked by another image task")
                time.sleep(min(self.poll_interval, max(0, deadline - time.monotonic())))
            self._handle = handle
            self._overlapped = overlapped
            self._lease = lease
            return self
        except BaseException:
            if "handle" in locals():
                _close(handle)
            if lease is not None:
                lease.close()
            raise

    def release(self) -> None:
        if self._handle is None:
            return
        handle, self._handle = self._handle, None
        overlapped, self._overlapped = self._overlapped, None
        first_error: BaseException | None = None
        try:
            if not _unlock_file(handle, 0, 1, 0, ctypes.byref(overlapped)):
                _raise_last_error(self.repository / ".repository.lock")
        except BaseException as exc:
            first_error = exc
        try:
            _close(handle)
        except BaseException as exc:
            if first_error is None:
                first_error = exc
        if self._lease is not None:
            try:
                self._lease.close()
            except BaseException as exc:
                if first_error is None:
                    first_error = exc
            self._lease = None
        if self._parent_lease is not None:
            try:
                self._parent_lease.close()
            except BaseException as exc:
                if first_error is None:
                    first_error = exc
            self._parent_lease = None
        if first_error is not None:
            raise first_error

    def __enter__(self) -> Self:
        return self.acquire()

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.release()


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
        if not re.fullmatch(r"sub_[0-9a-f]{32}", submission_id):
            raise ValueError("invalid submission ID")
        self.repository = Path(repository).absolute()
        self.submission_id = submission_id
        self.timeout = timeout
        self.poll_interval = poll_interval
        digest = hashlib.sha256(submission_id.encode("ascii")).digest()
        offset = int.from_bytes(digest[:8], "little")
        self._offset_low = offset & 0xFFFFFFFF
        self._offset_high = offset >> 32
        self._lease: DirectoryLease | None = None
        self._handle: int | None = None
        self._overlapped: _Overlapped | None = None

    def acquire(self) -> Self:
        if self._handle is not None:
            raise RuntimeError("submission lock is already acquired")
        deadline = time.monotonic() + self.timeout
        lease = DirectoryLease(self.repository)
        lock_path = self.repository / ".submission.lock"
        try:
            while True:
                try:
                    handle = _open_handle(
                        lock_path,
                        directory=False,
                        disposition=OPEN_ALWAYS,
                        shared_lock=True,
                    )
                    break
                except OSError as exc:
                    if exc.errno != ERROR_SHARING_VIOLATION:
                        raise
                    if time.monotonic() >= deadline:
                        raise TimeoutError("edit submission is still in progress") from exc
                    time.sleep(min(self.poll_interval, max(0, deadline - time.monotonic())))
            overlapped = _Overlapped()
            overlapped.offset = self._offset_low
            overlapped.offset_high = self._offset_high
            while not _lock_file(
                handle,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                ctypes.byref(overlapped),
            ):
                error = ctypes.get_last_error()
                if error != ERROR_LOCK_VIOLATION:
                    raise OSError(error, ctypes.FormatError(error), str(lock_path))
                if time.monotonic() >= deadline:
                    raise TimeoutError("edit submission is still in progress")
                time.sleep(min(self.poll_interval, max(0, deadline - time.monotonic())))
            self._handle = handle
            self._overlapped = overlapped
            self._lease = lease
            return self
        except BaseException:
            if "handle" in locals():
                _close(handle)
            lease.close()
            raise

    def release(self) -> None:
        if self._handle is None:
            return
        handle, self._handle = self._handle, None
        overlapped, self._overlapped = self._overlapped, None
        first_error: BaseException | None = None
        try:
            if not _unlock_file(handle, 0, 1, 0, ctypes.byref(overlapped)):
                _raise_last_error(self.repository / ".submission.lock")
        except BaseException as exc:
            first_error = exc
        try:
            _close(handle)
        except BaseException as exc:
            if first_error is None:
                first_error = exc
        if self._lease is not None:
            try:
                self._lease.close()
            except BaseException as exc:
                if first_error is None:
                    first_error = exc
            self._lease = None
        if first_error is not None:
            raise first_error

    def __enter__(self) -> Self:
        return self.acquire()

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.release()


class RepositoryMutation(AbstractContextManager["RepositoryMutation"]):
    def __init__(self, repository: Path, *, timeout: float = 10.0) -> None:
        self.repository = Path(repository).absolute()
        self._lock = RepositoryLock(self.repository, timeout=timeout)
        self._directory_handles: dict[str, int] = {}

    def create_directory(self, relative_path: str | Path) -> None:
        relative = _relative_path(relative_path)
        current = self.repository
        parent_handle = self._lock._lease._handles[-1]
        for part in relative.parts:
            current = current / part
            key = os.path.normcase(str(current))
            if key not in self._directory_handles:
                self._directory_handles[key] = _open_directory_relative(
                    parent_handle,
                    part,
                    current,
                    create=True,
                    delete_access=True,
                )
            parent_handle = self._directory_handles[key]

    def _protect_parent(self, relative: Path) -> None:
        current = self.repository
        parent_handle = self._lock._lease._handles[-1]
        for part in relative.parent.parts:
            current = current / part
            key = os.path.normcase(str(current))
            if key not in self._directory_handles:
                self._directory_handles[key] = _open_directory_relative(
                    parent_handle,
                    part,
                    current,
                    create=False,
                    delete_access=True,
                )
            parent_handle = self._directory_handles[key]

    def create_new_directory(self, relative_path: str | Path) -> None:
        relative = _relative_path(relative_path)
        parent_relative = relative.parent
        if parent_relative.parts:
            self.create_directory(parent_relative)
        target = self.repository / relative
        parent_key = os.path.normcase(str(target.parent))
        parent_handle = (
            self._lock._lease._handles[-1]
            if target.parent == self.repository
            else self._directory_handles[parent_key]
        )
        key = os.path.normcase(str(target))
        self._directory_handles[key] = _open_directory_relative(
            parent_handle,
            relative.parts[-1],
            target,
            create=True,
            create_new=True,
            delete_access=True,
        )

    def open_file(self, relative_path: str | Path, *, protect_from_rename: bool = False) -> VerifiedFile:
        relative = _relative_path(relative_path)
        self._protect_parent(relative)
        return VerifiedFile(
            _open_handle(
                self.repository / relative,
                directory=False,
                protect_from_rename=protect_from_rename,
            ),
            [],
        )

    def publish_new_file(self, relative_path: str | Path, data: bytes) -> None:
        relative = _relative_path(relative_path)
        self._protect_parent(relative)
        target = self.repository / relative
        _reject_reparse_path(target.parent, self.repository)
        handle = _open_handle(target, directory=False, disposition=CREATE_NEW)
        try:
            _write_all(handle, bytes(data))
        finally:
            _close(handle)

    def publish_replace_file(self, relative_path: str | Path, data: bytes) -> None:
        relative = _relative_path(relative_path)
        self._protect_parent(relative)
        target = self.repository / relative
        _reject_reparse_path(target.parent, self.repository)
        _reject_reparse_path(target, self.repository)
        temporary = target.with_name(f".{target.name}.{secrets.token_hex(8)}.tmp")
        handle = _open_handle(temporary, directory=False, disposition=CREATE_NEW)
        published = False
        try:
            _write_all(handle, bytes(data))
            _replace_file_by_handle(handle, temporary, target)
            published = True
        finally:
            if not published:
                _delete_file_by_handle(handle, temporary)
            _close(handle)

    def remove_directory_if_known(self, relative_path: str | Path, known_files: set[str]) -> None:
        relative = _relative_path(relative_path)
        target = self.repository / relative
        _reject_reparse_path(target, self.repository)
        target_key = os.path.normcase(str(target))
        directory_handle = self._directory_handles.pop(target_key, None)
        if directory_handle is None:
            self._protect_parent(relative / "placeholder")
            directory_handle = self._directory_handles.pop(target_key)
        try:
            entries = list(target.iterdir())
            entry_names = {entry.name for entry in entries}
            if not entry_names.issubset(set(known_files)):
                raise OSError("repository directory contains unknown entries")
            for entry in entries:
                file_handle = _open_handle(entry, directory=False, delete_access=True)
                try:
                    _delete_file_by_handle(file_handle, entry)
                finally:
                    _close(file_handle)
            _delete_file_by_handle(directory_handle, target)
        finally:
            _close(directory_handle)

    def __enter__(self) -> Self:
        self._lock.acquire()
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        handles = list(self._directory_handles.values())
        self._directory_handles.clear()
        first_error: BaseException | None = None
        try:
            _close_all(handles)
        except BaseException as exc:
            first_error = exc
        try:
            self._lock.release()
        except BaseException as exc:
            if first_error is None:
                first_error = exc
        if first_error is not None:
            raise first_error
