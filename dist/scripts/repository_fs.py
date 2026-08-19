from __future__ import annotations

import sys


if sys.platform == "win32":
    if __package__:
        from scripts.windows_repository_fs import (
            DirectoryLease,
            RepositoryLock,
            RepositoryMutation,
            SafeFileOperationError,
            SubmissionLock,
            VerifiedFile,
            delete_file_safely,
            ensure_directory_tree_safely,
            publish_new_file_safely,
        )
    else:
        from windows_repository_fs import (
            DirectoryLease,
            RepositoryLock,
            RepositoryMutation,
            SafeFileOperationError,
            SubmissionLock,
            VerifiedFile,
            delete_file_safely,
            ensure_directory_tree_safely,
            publish_new_file_safely,
        )
elif sys.platform == "darwin" or sys.platform.startswith("linux"):
    if __package__:
        from scripts.posix_repository_fs import (
            DirectoryLease,
            RepositoryLock,
            RepositoryMutation,
            SafeFileOperationError,
            SubmissionLock,
            VerifiedFile,
            delete_file_safely,
            ensure_directory_tree_safely,
            publish_new_file_safely,
        )
    else:
        from posix_repository_fs import (
            DirectoryLease,
            RepositoryLock,
            RepositoryMutation,
            SafeFileOperationError,
            SubmissionLock,
            VerifiedFile,
            delete_file_safely,
            ensure_directory_tree_safely,
            publish_new_file_safely,
        )
else:
    raise RuntimeError(f"repository filesystem is not supported on {sys.platform}")


__all__ = [
    "DirectoryLease",
    "RepositoryLock",
    "RepositoryMutation",
    "SafeFileOperationError",
    "SubmissionLock",
    "VerifiedFile",
    "delete_file_safely",
    "ensure_directory_tree_safely",
    "publish_new_file_safely",
]
