from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile

from native_host.cc_batch.archive import ArchiveError, extract_single_txt


class ArchiveTests(unittest.TestCase):
    def make_zip(self, directory: str, name: str, members: dict[str, bytes]) -> Path:
        path = Path(directory) / name
        with ZipFile(path, "w", ZIP_DEFLATED) as archive:
            for member, payload in members.items():
                archive.writestr(member, payload)
        return path

    def test_keeps_only_one_txt_and_deletes_source_zip(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.make_zip(directory, "archive.zip", {"data.json": b"{}", "inside.txt": "Name: Alice\n".encode()})
            target = Path(directory) / "txt"
            result = extract_single_txt(source, target)
            self.assertEqual(result.text, "Name: Alice\n")
            self.assertEqual(result.txt_path.read_text(encoding="utf-8"), "Name: Alice\n")
            self.assertFalse(source.exists())
            self.assertEqual([path.suffix for path in target.iterdir()], [".txt"])

    def test_multiple_txt_is_rejected_and_zip_is_cleaned(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.make_zip(directory, "archive.zip", {"a.txt": b"a", "b.txt": b"b"})
            with self.assertRaises(ArchiveError):
                extract_single_txt(source, Path(directory) / "txt")
            self.assertFalse(source.exists())

    def test_zip_slip_member_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.make_zip(directory, "archive.zip", {"../evil.txt": b"evil"})
            with self.assertRaises(ArchiveError):
                extract_single_txt(source, Path(directory) / "txt")
            self.assertFalse((Path(directory).parent / "evil.txt").exists())

    def test_txt_replace_failure_is_reported_and_zip_is_cleaned(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.make_zip(directory, "archive.zip", {"inside.txt": b"secret"})
            target = Path(directory) / "txt"
            with patch("native_host.cc_batch.archive.os.replace", side_effect=OSError("locked")):
                with self.assertRaisesRegex(ArchiveError, "txt_save_failed") as raised:
                    extract_single_txt(source, target)
            self.assertEqual(raised.exception.code, "txt_save_failed")
            self.assertFalse(source.exists())
            self.assertEqual(list(target.glob("*.tmp")), [])
            self.assertEqual(list(target.glob("tmp*")), [])

    def test_txt_write_failure_is_reported_and_temporary_file_is_cleaned(self):
        class FailingWriter:
            name = ""

            def __init__(self, path: Path):
                self.name = str(path)

            def __enter__(self):
                Path(self.name).write_text("", encoding="utf-8")
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def write(self, text: str) -> None:
                raise OSError("disk full")

        with tempfile.TemporaryDirectory() as directory:
            source = self.make_zip(directory, "archive.zip", {"inside.txt": b"secret"})
            target = Path(directory) / "txt"
            temporary = target / "partial.tmp"

            def named_temporary_file(*args, **kwargs):
                return FailingWriter(temporary)

            with patch("native_host.cc_batch.archive.tempfile.NamedTemporaryFile", new=named_temporary_file):
                with self.assertRaisesRegex(ArchiveError, "txt_save_failed") as raised:
                    extract_single_txt(source, target)
            self.assertEqual(raised.exception.code, "txt_save_failed")
            self.assertFalse(source.exists())
            self.assertFalse(temporary.exists())

    def test_txt_directory_creation_failure_is_a_recoverable_save_error(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.make_zip(directory, "archive.zip", {"inside.txt": b"secret"})
            blocked = Path(directory) / "blocked"
            blocked.write_text("not a directory", encoding="utf-8")
            with self.assertRaisesRegex(ArchiveError, "txt_save_failed"):
                extract_single_txt(source, blocked / "txt")
            self.assertFalse(source.exists())
