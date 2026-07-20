"""Batch preflight, per-download processing, and resumable status updates."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from uuid import uuid4

from .archive import ArchiveError, extract_single_txt
from .config import Config
from .input_workbook import InputTask, read_input_tasks
from .logging_setup import EventLogger
from .output_workbook import HistoryWorkbook, HistoryWorkbookError
from .state import StateStore
from .text_fields import extract_fields


class ProcessorFatal(RuntimeError):
    """Raised when the batch cannot safely continue."""


@dataclass(frozen=True)
class PlannedTask:
    source_row: int
    url: str
    sequence: int
    validation_error: str | None = None


@dataclass(frozen=True)
class BatchPlan:
    batch_id: str
    tasks: list[PlannedTask]


class BatchProcessor:
    def __init__(self, config: Config, *, state_path: str | Path, log_path: str | Path):
        self.config = config
        self.history = HistoryWorkbook(config.output_excel)
        self.state = StateStore(state_path)
        self.logger = EventLogger(log_path)

    def preflight(self) -> None:
        if not self.config.input_excel.exists():
            raise ProcessorFatal("input_excel_missing")
        self.config.txt_directory.mkdir(parents=True, exist_ok=True)
        (self.config.download_directory or self.config.txt_directory).mkdir(parents=True, exist_ok=True)
        try:
            self.history.preflight()
        except HistoryWorkbookError as exc:
            raise ProcessorFatal(str(exc)) from exc

    def prepare_batch(self, *, resume_only: bool = False) -> BatchPlan:
        self.preflight()
        existing = self.state.load()
        existing_tasks = existing.get("tasks") if isinstance(existing, dict) else None
        if existing.get("batch_id") and isinstance(existing_tasks, list):
            recorded = self.history.recorded_sequences()
            pending: list[PlannedTask] = []
            changed = False
            for item in existing_tasks:
                if item.get("result") == "pending" and item.get("sequence") in recorded:
                    item["result"] = "recovered"
                    changed = True
                if item.get("result") == "pending":
                    pending.append(
                        PlannedTask(
                            source_row=int(item["source_row"]),
                            url=str(item["url"]),
                            sequence=int(item["sequence"]),
                            validation_error=item.get("validation_error"),
                        )
                    )
            if changed:
                self.state.save(existing)
            if pending:
                batch_id = str(existing["batch_id"])
                self.logger.event(batch_id=batch_id, event="batch_resumed", total=len(pending))
                return BatchPlan(batch_id, pending)
            if resume_only:
                batch_id = str(existing["batch_id"])
                self.logger.event(batch_id=batch_id, event="batch_resume_complete", total=0)
                return BatchPlan(batch_id, [])
        try:
            source_tasks = read_input_tasks(self.config.input_excel, self.config.url_column)
            sequence = self.history.next_sequence()
        except (OSError, ValueError, HistoryWorkbookError) as exc:
            raise ProcessorFatal(str(exc)) from exc
        tasks = [
            PlannedTask(task.source_row, task.url, sequence + offset, task.validation_error)
            for offset, task in enumerate(source_tasks)
        ]
        plan = BatchPlan(str(uuid4()), tasks)
        self.state.start(plan.batch_id, [asdict(task) | {"result": "pending"} for task in tasks])
        self.logger.event(batch_id=plan.batch_id, event="batch_prepared", total=len(tasks))
        return plan

    def _record(self, task: PlannedTask, *, zip_name: str | None, fields: dict[str, str], success: bool, error: str | None) -> str:
        try:
            self.history.append(sequence=task.sequence, zip_name=zip_name, fields=fields, success=success)
        except HistoryWorkbookError as exc:
            self.logger.event(event="fatal", source_row=task.source_row, sequence=task.sequence, error=str(exc))
            raise ProcessorFatal(str(exc)) from exc
        self.state.update(task.sequence, "success" if success else "failure", error)
        self.logger.event(
            event="task_result",
            source_row=task.source_row,
            sequence=task.sequence,
            url=task.url,
            zip_name=zip_name,
            status="成功" if success else "失败",
            error=error,
        )
        return "success" if success else "failure"

    def _cleanup_recorded_zip(self, task: PlannedTask, path: Path) -> None:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            self.logger.event(event="zip_cleanup_failed", source_row=task.source_row, sequence=task.sequence)

    def _cleanup_reconciled_download(self, task: PlannedTask, download_path: str | Path | None) -> None:
        if download_path is None:
            return
        try:
            resolved = Path(download_path).resolve(strict=True)
            allowed_directory = (self.config.download_directory or self.config.txt_directory).resolve()
        except OSError:
            return
        if resolved.parent == allowed_directory and resolved.suffix.lower() == ".zip":
            self._cleanup_recorded_zip(task, resolved)

    def process_result(self, task: PlannedTask, download_path: str | Path | None) -> str:
        state = self.state.load()
        state_record = next(
            (item for item in state.get("tasks", []) if item.get("sequence") == task.sequence),
            None,
        )
        if state_record and state_record.get("result") in {"success", "failure"}:
            self._cleanup_reconciled_download(task, download_path)
            return str(state_record["result"])
        history_status = self.history.status_for_sequence(task.sequence)
        if history_status:
            self.state.update(task.sequence, history_status)
            self._cleanup_reconciled_download(task, download_path)
            return history_status
        if task.validation_error:
            return self._record(task, zip_name=None, fields={}, success=False, error=task.validation_error)
        if download_path is None:
            return self._record(task, zip_name=None, fields={}, success=False, error="download_failed")
        download_path = Path(download_path)
        known_zip_name = download_path.name
        allowed_directory = (self.config.download_directory or self.config.txt_directory).resolve()
        try:
            resolved_download = download_path.resolve(strict=True)
        except OSError:
            return self._record(task, zip_name=known_zip_name, fields={}, success=False, error="download_missing")
        if resolved_download.parent != allowed_directory or resolved_download.suffix.lower() != ".zip":
            return self._record(task, zip_name=known_zip_name, fields={}, success=False, error="download_path_not_allowed")
        try:
            extracted = extract_single_txt(
                resolved_download,
                self.config.txt_directory,
                delete_source_on_success=False,
                delete_source_on_failure=False,
            )
        except ArchiveError as exc:
            status = self._record(task, zip_name=known_zip_name, fields={}, success=False, error=exc.code)
            self._cleanup_recorded_zip(task, resolved_download)
            return status
        extraction = extract_fields(
            extracted.text,
            self.config.field_mappings,
            continuation_lines=self.config.field_continuation_lines,
        )
        if extraction.missing_fields:
            status = self._record(task, zip_name=extracted.zip_name, fields=extraction.values, success=False, error="missing_fields:" + ",".join(extraction.missing_fields))
            self._cleanup_recorded_zip(task, extracted.source_path)
            return status
        status = self._record(task, zip_name=extracted.zip_name, fields=extraction.values, success=True, error=None)
        self._cleanup_recorded_zip(task, extracted.source_path)
        return status
