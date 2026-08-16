import argparse
import ctypes
import json
import ntpath
import os
import re
import sys
import time
import uuid
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
if str(PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(PLUGIN_ROOT))


COINIT_APARTMENTTHREADED = 0x2
CLSCTX_INPROC_SERVER = 0x1
CLSCTX_LOCAL_SERVER = 0x4
DISPATCH_METHOD = 0x1
DISPATCH_PROPERTYGET = 0x2
VT_EMPTY = 0
VT_I4 = 3
VT_BSTR = 8
VT_DISPATCH = 9
VT_BOOL = 11
VT_UI4 = 19
SW_RESTORE = 9
GA_ROOT = 2
WINDOW_VISIBILITY_TIMEOUT_SECONDS = 6.0
WINDOW_VISIBILITY_POLL_SECONDS = 0.02
ARTIFACT_ID_PATTERN = re.compile(r"^img_[0-9A-HJKMNP-TV-Z]{26}$")
IMAGE_FILE_BY_MIME_TYPE = {
    "image/png": "image.png",
    "image/jpeg": "image.jpg",
    "image/webp": "image.webp",
}


class Guid(ctypes.Structure):
    _fields_ = [
        ("data1", ctypes.c_ulong),
        ("data2", ctypes.c_ushort),
        ("data3", ctypes.c_ushort),
        ("data4", ctypes.c_ubyte * 8),
    ]


def guid(value):
    parsed = uuid.UUID(value)
    return Guid(
        parsed.time_low,
        parsed.time_mid,
        parsed.time_hi_version,
        (ctypes.c_ubyte * 8).from_buffer_copy(parsed.bytes[8:]),
    )


CLSID_SHELL_WINDOWS = guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39")
IID_IDISPATCH = guid("00020400-0000-0000-C000-000000000046")
IID_NULL = guid("00000000-0000-0000-0000-000000000000")
IID_ISERVICE_PROVIDER = guid("6D5140C1-7436-11CE-8034-00AA006009FA")
SID_TOP_LEVEL_BROWSER = guid("4C96BE40-915C-11CF-99D3-00AA004AE837")
IID_ISHELL_BROWSER = guid("000214E2-0000-0000-C000-000000000046")
COM_FUNCTION = getattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE)


class VariantValue(ctypes.Union):
    _fields_ = [
        ("ll_value", ctypes.c_longlong),
        ("long_value", ctypes.c_long),
        ("unsigned_long_value", ctypes.c_ulong),
        ("bool_value", ctypes.c_short),
        ("bstr_value", ctypes.c_void_p),
        ("dispatch_value", ctypes.c_void_p),
        ("decimal_storage", ctypes.c_ubyte * 16),
    ]


class Variant(ctypes.Structure):
    _anonymous_ = ("value",)
    _fields_ = [
        ("variant_type", ctypes.c_ushort),
        ("reserved1", ctypes.c_ushort),
        ("reserved2", ctypes.c_ushort),
        ("reserved3", ctypes.c_ushort),
        ("value", VariantValue),
    ]


class DispatchParameters(ctypes.Structure):
    _fields_ = [
        ("arguments", ctypes.POINTER(Variant)),
        ("named_arguments", ctypes.POINTER(ctypes.c_long)),
        ("argument_count", ctypes.c_uint),
        ("named_argument_count", ctypes.c_uint),
    ]


class ComInterface:
    def __init__(self, pointer):
        value = pointer.value if isinstance(pointer, ctypes.c_void_p) else pointer
        if not value:
            raise RuntimeError("shell_com_interface_unavailable")
        self.pointer = ctypes.c_void_p(value)
        self.vtable = ctypes.cast(
            self.pointer,
            ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)),
        ).contents
        self.closed = False

    def add_ref(self):
        callback = COM_FUNCTION(ctypes.c_ulong, ctypes.c_void_p)(self.vtable[1])
        callback(self.pointer)

    def close(self):
        if self.closed:
            return
        self.closed = True
        callback = COM_FUNCTION(ctypes.c_ulong, ctypes.c_void_p)(self.vtable[2])
        callback(self.pointer)

    def query_interface(self, interface_id):
        pointer = ctypes.c_void_p()
        callback = COM_FUNCTION(
            ctypes.c_long,
            ctypes.c_void_p,
            ctypes.POINTER(Guid),
            ctypes.POINTER(ctypes.c_void_p),
        )(self.vtable[0])
        result = callback(self.pointer, ctypes.byref(interface_id), ctypes.byref(pointer))
        _require_com_success(result, "shell_com_query_failed")
        return ComInterface(pointer)

    def query_service(self, service_id, interface_id):
        pointer = ctypes.c_void_p()
        callback = COM_FUNCTION(
            ctypes.c_long,
            ctypes.c_void_p,
            ctypes.POINTER(Guid),
            ctypes.POINTER(Guid),
            ctypes.POINTER(ctypes.c_void_p),
        )(self.vtable[3])
        result = callback(
            self.pointer,
            ctypes.byref(service_id),
            ctypes.byref(interface_id),
            ctypes.byref(pointer),
        )
        _require_com_success(result, "shell_browser_query_failed")
        return ComInterface(pointer)

    def get_window(self):
        window = ctypes.c_void_p()
        callback = COM_FUNCTION(
            ctypes.c_long,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_void_p),
        )(self.vtable[3])
        result = callback(self.pointer, ctypes.byref(window))
        _require_com_success(result, "shell_browser_window_failed")
        if not window.value:
            raise RuntimeError("shell_browser_window_unavailable")
        return window.value


class ComDispatch(ComInterface):
    @classmethod
    def create_shell_windows(cls):
        ole32 = ctypes.WinDLL("ole32", use_last_error=True)
        ole32.CoCreateInstance.argtypes = [
            ctypes.POINTER(Guid),
            ctypes.c_void_p,
            ctypes.c_uint,
            ctypes.POINTER(Guid),
            ctypes.POINTER(ctypes.c_void_p),
        ]
        ole32.CoCreateInstance.restype = ctypes.c_long
        pointer = ctypes.c_void_p()
        result = ole32.CoCreateInstance(
            ctypes.byref(CLSID_SHELL_WINDOWS),
            None,
            CLSCTX_INPROC_SERVER | CLSCTX_LOCAL_SERVER,
            ctypes.byref(IID_IDISPATCH),
            ctypes.byref(pointer),
        )
        _require_com_success(result, "shell_windows_unavailable")
        return cls(pointer)

    def invoke(self, name, arguments=()):
        dispatch_id = self._get_dispatch_id(name)
        variant_arguments = (Variant * len(arguments))()
        for index, argument in enumerate(reversed(arguments)):
            if isinstance(argument, bool):
                variant_arguments[index].variant_type = VT_BOOL
                variant_arguments[index].bool_value = -1 if argument else 0
            elif isinstance(argument, int):
                variant_arguments[index].variant_type = VT_I4
                variant_arguments[index].long_value = argument
            else:
                raise TypeError("unsupported shell automation argument")
        parameters = DispatchParameters(
            variant_arguments if arguments else None,
            None,
            len(arguments),
            0,
        )
        oleaut32 = ctypes.WinDLL("oleaut32", use_last_error=True)
        oleaut32.VariantInit.argtypes = [ctypes.POINTER(Variant)]
        oleaut32.VariantClear.argtypes = [ctypes.POINTER(Variant)]
        oleaut32.SysStringLen.argtypes = [ctypes.c_void_p]
        oleaut32.SysStringLen.restype = ctypes.c_uint
        result_variant = Variant()
        oleaut32.VariantInit(ctypes.byref(result_variant))
        callback = COM_FUNCTION(
            ctypes.c_long,
            ctypes.c_void_p,
            ctypes.c_long,
            ctypes.POINTER(Guid),
            ctypes.c_uint,
            ctypes.c_ushort,
            ctypes.POINTER(DispatchParameters),
            ctypes.POINTER(Variant),
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_uint),
        )(self.vtable[6])
        result = callback(
            self.pointer,
            dispatch_id,
            ctypes.byref(IID_NULL),
            0,
            DISPATCH_METHOD | DISPATCH_PROPERTYGET,
            ctypes.byref(parameters),
            ctypes.byref(result_variant),
            None,
            None,
        )
        if result < 0:
            oleaut32.VariantClear(ctypes.byref(result_variant))
            _require_com_success(result, f"shell_dispatch_failed:{name}")
        try:
            variant_type = result_variant.variant_type & 0x0FFF
            if variant_type == VT_EMPTY:
                return None
            if variant_type == VT_I4:
                return result_variant.long_value
            if variant_type == VT_UI4:
                return result_variant.unsigned_long_value
            if variant_type == VT_BOOL:
                return result_variant.bool_value != 0
            if variant_type == VT_BSTR:
                if not result_variant.bstr_value:
                    return ""
                return ctypes.wstring_at(
                    result_variant.bstr_value,
                    oleaut32.SysStringLen(result_variant.bstr_value),
                )
            if variant_type == VT_DISPATCH:
                dispatch = ComDispatch(result_variant.dispatch_value)
                dispatch.add_ref()
                return dispatch
            raise RuntimeError(f"shell_dispatch_type_unsupported:{variant_type}")
        finally:
            oleaut32.VariantClear(ctypes.byref(result_variant))

    def _get_dispatch_id(self, name):
        callback = COM_FUNCTION(
            ctypes.c_long,
            ctypes.c_void_p,
            ctypes.POINTER(Guid),
            ctypes.POINTER(ctypes.c_wchar_p),
            ctypes.c_uint,
            ctypes.c_uint,
            ctypes.POINTER(ctypes.c_long),
        )(self.vtable[5])
        names = (ctypes.c_wchar_p * 1)(name)
        dispatch_id = ctypes.c_long()
        result = callback(
            self.pointer,
            ctypes.byref(IID_NULL),
            names,
            1,
            0,
            ctypes.byref(dispatch_id),
        )
        _require_com_success(result, f"shell_dispatch_name_failed:{name}")
        return dispatch_id.value


def _require_com_success(result, error_code):
    if result < 0:
        raise RuntimeError(f"{error_code}: 0x{result & 0xFFFFFFFF:08x}")


class WindowsWindowApi:
    def __init__(self):
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.user32.GetForegroundWindow.argtypes = []
        self.user32.GetForegroundWindow.restype = ctypes.c_void_p
        self.user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
        self.user32.IsWindowVisible.restype = ctypes.c_bool
        self.user32.ShowWindowAsync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.user32.ShowWindowAsync.restype = ctypes.c_bool
        self.user32.SetForegroundWindow.argtypes = [ctypes.c_void_p]
        self.user32.SetForegroundWindow.restype = ctypes.c_bool
        self.user32.GetAncestor.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        self.user32.GetAncestor.restype = ctypes.c_void_p
        self._last_records = []

    def get_foreground_window(self):
        return self.user32.GetForegroundWindow()

    def find_explorer_windows(self, folder_path):
        expected = normalize_windows_path(folder_path)
        self._last_records = self._enumerate_explorer_windows()
        return [
            record
            for record in self._last_records
            if normalize_windows_path(record["folderPath"]) == expected
        ]

    def get_selected_paths(self, window, folder_path):
        expected_folder = normalize_windows_path(folder_path)
        if isinstance(window, dict):
            if normalize_windows_path(window["folderPath"]) != expected_folder:
                return []
            return list(window.get("selectedPaths", []))
        selected_paths = []
        for record in self._last_records:
            if record["handle"] != window:
                continue
            if normalize_windows_path(record["folderPath"]) != expected_folder:
                continue
            selected_paths.extend(record["selectedPaths"])
        return selected_paths

    def is_window_visible(self, window):
        handle = window_handle(window)
        if not self.user32.IsWindowVisible(handle):
            return False
        view_handle = window_view_handle(window)
        return not view_handle or bool(self.user32.IsWindowVisible(view_handle))

    def restore_window(self, window):
        self.user32.ShowWindowAsync(window_handle(window), SW_RESTORE)

    def set_foreground_window(self, window):
        return bool(self.user32.SetForegroundWindow(window_handle(window)))

    def is_window_foreground(self, window):
        return self.get_foreground_window() == window_handle(window)

    def top_level_window_handle(self, window):
        root = self.user32.GetAncestor(window, GA_ROOT)
        if not root:
            raise RuntimeError("shell_top_level_window_unavailable")
        return root

    def _enumerate_explorer_windows(self):
        shell_windows = ComDispatch.create_shell_windows()
        records = []
        try:
            count = int(shell_windows.invoke("Count") or 0)
            for index in range(count):
                window = None
                document = None
                folder = None
                folder_item = None
                selected_items = None
                try:
                    window = shell_windows.invoke("Item", (index,))
                    document = window.invoke("Document")
                    folder = document.invoke("Folder")
                    folder_item = folder.invoke("Self")
                    folder_path = folder_item.invoke("Path")
                    if not isinstance(folder_path, str) or folder_path.startswith("::"):
                        continue
                    browser_handle = shell_browser_window_handle(document)
                    handle = self.top_level_window_handle(browser_handle)
                    selected_items = document.invoke("SelectedItems")
                    selected_paths = []
                    selected_count = int(selected_items.invoke("Count") or 0)
                    for selected_index in range(selected_count):
                        selected_item = selected_items.invoke("Item", (selected_index,))
                        try:
                            selected_path = selected_item.invoke("Path")
                            if isinstance(selected_path, str) and selected_path:
                                selected_paths.append(selected_path)
                        finally:
                            selected_item.close()
                    records.append({
                        "handle": handle,
                        "viewHandle": browser_handle,
                        "folderPath": folder_path,
                        "selectedPaths": selected_paths,
                    })
                except (AttributeError, RuntimeError, TypeError):
                    # Virtual shell windows do not expose file-system folder views.
                    continue
                finally:
                    for item in (selected_items, folder_item, folder, document, window):
                        if isinstance(item, ComInterface):
                            item.close()
        finally:
            shell_windows.close()
        return records


def shell_browser_window_handle(document):
    service_provider = document.query_interface(IID_ISERVICE_PROVIDER)
    try:
        shell_browser = service_provider.query_service(
            SID_TOP_LEVEL_BROWSER,
            IID_ISHELL_BROWSER,
        )
        try:
            return shell_browser.get_window()
        finally:
            shell_browser.close()
    finally:
        service_provider.close()


def normalize_windows_path(value):
    return ntpath.normcase(ntpath.normpath(str(value))).rstrip("\\/")


def window_handle(window):
    return window["handle"] if isinstance(window, dict) else window


def window_view_handle(window):
    return window.get("viewHandle") if isinstance(window, dict) else None


def window_identity(window):
    if isinstance(window, dict):
        return (window["handle"], window.get("viewHandle"))
    return window


class WindowsShellApi:
    def __init__(self):
        self.ole32 = ctypes.WinDLL("ole32")
        self.shell32 = ctypes.WinDLL("shell32", use_last_error=True)
        self.ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        self.ole32.CoInitializeEx.restype = ctypes.c_long
        self.ole32.CoUninitialize.argtypes = []
        self.shell32.ILCreateFromPathW.argtypes = [ctypes.c_wchar_p]
        self.shell32.ILCreateFromPathW.restype = ctypes.c_void_p
        self.shell32.ILClone.argtypes = [ctypes.c_void_p]
        self.shell32.ILClone.restype = ctypes.c_void_p
        self.shell32.ILRemoveLastID.argtypes = [ctypes.c_void_p]
        self.shell32.ILRemoveLastID.restype = ctypes.c_bool
        self.shell32.ILFindLastID.argtypes = [ctypes.c_void_p]
        self.shell32.ILFindLastID.restype = ctypes.c_void_p
        self.shell32.SHOpenFolderAndSelectItems.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint,
            ctypes.POINTER(ctypes.c_void_p),
            ctypes.c_uint,
        ]
        self.shell32.SHOpenFolderAndSelectItems.restype = ctypes.c_long
        self.shell32.ILFree.argtypes = [ctypes.c_void_p]
        self.window_api = WindowsWindowApi()

    def select_file(self, target):
        initialization = self.ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED)
        if initialization < 0:
            raise RuntimeError(f"com_initialization_failed: 0x{initialization & 0xFFFFFFFF:08x}")
        try:
            result = open_and_select_shell_item(self.shell32, target)
            if result < 0:
                raise RuntimeError(f"shell_api_failed: 0x{result & 0xFFFFFFFF:08x}")
            return ensure_target_explorer_visible(target, self.window_api)
        finally:
            self.ole32.CoUninitialize()


def open_and_select_shell_item(shell32, target):
    file_id_list = shell32.ILCreateFromPathW(target)
    if not file_id_list:
        raise RuntimeError("shell_item_resolution_failed")
    folder_id_list = shell32.ILClone(file_id_list)
    if not folder_id_list or not shell32.ILRemoveLastID(folder_id_list):
        if folder_id_list:
            shell32.ILFree(folder_id_list)
        shell32.ILFree(file_id_list)
        raise RuntimeError("shell_folder_resolution_failed")
    child_id = shell32.ILFindLastID(file_id_list)
    if not child_id:
        shell32.ILFree(folder_id_list)
        shell32.ILFree(file_id_list)
        raise RuntimeError("shell_child_resolution_failed")
    children = (ctypes.c_void_p * 1)(child_id)
    try:
        return shell32.SHOpenFolderAndSelectItems(
            folder_id_list,
            1,
            children,
            0,
        )
    finally:
        shell32.ILFree(folder_id_list)
        shell32.ILFree(file_id_list)


def ensure_target_explorer_visible(
    target,
    window_api,
    *,
    timeout_seconds=WINDOW_VISIBILITY_TIMEOUT_SECONDS,
    sleep_seconds=WINDOW_VISIBILITY_POLL_SECONDS,
):
    target_path = str(Path(target).resolve())
    folder_path = str(Path(target_path).parent)
    expected_target = normalize_windows_path(target_path)
    deadline = time.monotonic() + timeout_seconds
    activated_identity = None
    restoring_identity = None
    while time.monotonic() < deadline:
        windows = list(window_api.find_explorer_windows(folder_path))
        records_by_identity = {window_identity(window): window for window in windows}
        target_selected = False
        active_window = None

        if activated_identity is not None:
            active_window = records_by_identity.get(activated_identity)
            if active_window is not None:
                target_selected = target_is_selected(active_window, folder_path, expected_target, window_api)
        elif restoring_identity is not None:
            restoring_window = records_by_identity.get(restoring_identity)
            if restoring_window is None:
                restoring_identity = None
            else:
                target_selected = target_is_selected(
                    restoring_window,
                    folder_path,
                    expected_target,
                    window_api,
                )
                if not target_selected:
                    restoring_identity = None
                elif window_api.is_window_visible(restoring_window):
                    activated_identity = restoring_identity
                    active_window = restoring_window
                    window_api.set_foreground_window(active_window)
        if activated_identity is None and restoring_identity is None:
            ordered_windows = ordered_explorer_windows(windows, window_api)
            matching_windows = [
                window
                for window in ordered_windows
                if target_is_selected(window, folder_path, expected_target, window_api)
            ]
            visible_matches = [
                window for window in matching_windows if window_api.is_window_visible(window)
            ]
            if len(visible_matches) == 1:
                activated_identity = window_identity(visible_matches[0])
                active_window = visible_matches[0]
                target_selected = True
                window_api.set_foreground_window(active_window)
            elif len(visible_matches) == 0 and len(matching_windows) == 1:
                restoring_identity = window_identity(matching_windows[0])
                window_api.restore_window(matching_windows[0])
                target_selected = True

        if active_window is not None:
            window_visible = window_api.is_window_visible(active_window)
            window_foreground = window_api.is_window_foreground(active_window)
            if target_selected and window_visible and window_foreground:
                return {
                    "targetSelected": True,
                    "windowVisible": True,
                    "windowForeground": True,
                }
        time.sleep(sleep_seconds)
    raise RuntimeError("shell_window_visibility_failed")


def target_is_selected(window, folder_path, expected_target, window_api):
    return any(
        normalize_windows_path(selected_path) == expected_target
        for selected_path in window_api.get_selected_paths(window, folder_path)
    )


def ordered_explorer_windows(windows, window_api):
    visible_windows = [window for window in windows if window_api.is_window_visible(window)]
    return visible_windows + [window for window in windows if window not in visible_windows]


def reveal_in_explorer(target, *, os_name=os.name, shell_api=None):
    if os_name != "nt":
        raise RuntimeError("artifact reveal is not supported on this platform")
    resolved_target = Path(target).resolve()
    if not resolved_target.is_absolute() or not resolved_target.is_file():
        raise RuntimeError("artifact image is unavailable")
    api = shell_api or WindowsShellApi()
    confirmation = api.select_file(str(resolved_target))
    if any(confirmation.get(field) is not True for field in (
        "targetSelected",
        "windowVisible",
        "windowForeground",
    )):
        raise RuntimeError("shell_selection_confirmation_incomplete")
    return {"status": "revealed", **confirmation}


def reveal_artifact(repository, image_id, *, os_name=os.name, shell_api=None):
    if os_name != "nt":
        raise RuntimeError("artifact reveal is not supported on this platform")
    repository = Path(repository)
    if not repository.is_absolute():
        raise ValueError("artifact root is required")
    if not isinstance(image_id, str) or not ARTIFACT_ID_PATTERN.fullmatch(image_id):
        raise ValueError("invalid artifact ID")

    from scripts.windows_repository_fs import DirectoryLease

    with DirectoryLease(repository) as lease:
        with lease.open_file("index.json", protect_from_rename=True) as index_file:
            try:
                index = json.loads(index_file.read_bytes())
            except json.JSONDecodeError as error:
                raise ValueError("artifact index is not valid JSON") from error
            if not isinstance(index, dict):
                raise ValueError("artifact index has an unsupported schema")
            artifacts = index.get("artifacts")
            if index.get("version") != 1 or not isinstance(artifacts, dict):
                raise ValueError("artifact index has an unsupported schema")
            entry = artifacts.get(image_id)
            if not isinstance(entry, dict):
                raise FileNotFoundError("artifact not found")
            if entry.get("id") != image_id:
                raise ValueError("artifact has an invalid identity")
            expected_name = IMAGE_FILE_BY_MIME_TYPE.get(entry.get("mimeType"))
            if expected_name is None or entry.get("imageFile") != expected_name:
                raise ValueError("artifact has an invalid image file")
            relative_image = Path("artifacts") / image_id / expected_name
            with lease.open_file(relative_image, protect_from_rename=True):
                return reveal_in_explorer(
                    repository / relative_image,
                    os_name=os_name,
                    shell_api=shell_api,
                )


def main(argv=None):
    arguments = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--artifact-root", required=True)
    parser.add_argument("--image-id", required=True)
    parsed = parser.parse_args(arguments)
    result = reveal_artifact(parsed.artifact_root, parsed.image_id)
    sys.stdout.write(f"{json.dumps(result, separators=(',', ':'))}\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(f"{error}\n")
        raise SystemExit(1)
