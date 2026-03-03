import os
import sys
import threading
import subprocess
import datetime
import shutil
import time
import json
import urllib.request
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from tkinter.scrolledtext import ScrolledText


class StressTestApp:
    def __init__(self, root):
        self.root = root
        self.root.title("English4SP Stress Test Runner")
        self.root.geometry("980x760")

        self.process = None
        self.reader_thread = None
        self.progress_after_id = None
        self.run_started_at = None
        self.run_target_seconds = 0
        self.ping_thread = None
        self.ping_stop = None
        self.ping_stats = None

        self.workspace_dir = os.path.dirname(os.path.abspath(__file__))
        self.script_path = os.path.join(self.workspace_dir, "scripts", "stress_candidates.js")
        self.reports_dir = os.path.join(self.workspace_dir, "stress-reports")
        os.makedirs(self.reports_dir, exist_ok=True)

        self._build_ui()
        self._set_defaults()

    def _build_ui(self):
        frm = ttk.Frame(self.root, padding=10)
        frm.pack(fill=tk.BOTH, expand=True)

        cfg = ttk.LabelFrame(frm, text="Settings", padding=10)
        cfg.pack(fill=tk.X)

        self.base_url = tk.StringVar()
        self.links_file = tk.StringVar()
        self.concurrency = tk.StringVar()
        self.duration_minutes = tk.StringVar()
        self.snapshot_size_kb = tk.StringVar()
        self.snapshot_count = tk.StringVar()
        self.presence_interval_sec = tk.StringVar()
        self.listening_interval_sec = tk.StringVar()
        self.listening_actions = tk.StringVar()
        self.play_start_minute = tk.StringVar()
        self.play_end_minute = tk.StringVar()
        self.audio_wait_minutes = tk.StringVar()
        self.answer_phase_minutes = tk.StringVar()
        self.submit_window_minutes = tk.StringVar()
        self.listening_chunk_kb = tk.StringVar()
        self.timeout_ms = tk.StringVar()
        self.ping_interval_sec = tk.StringVar()
        self.slo_p95_warn_ms = tk.StringVar()
        self.slo_p95_crit_ms = tk.StringVar()
        self.slo_fail_warn_pct = tk.StringVar()
        self.slo_fail_crit_pct = tk.StringVar()
        self.fail_rate_threshold = tk.StringVar()
        self.report_file = tk.StringVar()

        self.with_presence = tk.BooleanVar(value=True)
        self.with_listening = tk.BooleanVar(value=True)
        self.with_snapshots = tk.BooleanVar(value=True)
        self.realistic_flow = tk.BooleanVar(value=True)
        self.strict_exam_links = tk.BooleanVar(value=True)
        self.enable_ping = tk.BooleanVar(value=True)

        row = 0
        ttk.Label(cfg, text="Base URL").grid(row=row, column=0, sticky="w")
        ttk.Entry(cfg, textvariable=self.base_url, width=70).grid(row=row, column=1, columnspan=3, sticky="we", padx=(8, 0))

        row += 1
        ttk.Label(cfg, text="Excel/TXT/CSV links file").grid(row=row, column=0, sticky="w")
        ttk.Entry(cfg, textvariable=self.links_file, width=60).grid(row=row, column=1, sticky="we", padx=(8, 8))
        ttk.Button(cfg, text="Browse...", command=self._browse_links).grid(row=row, column=2, sticky="w")

        row += 1
        ttk.Label(cfg, text="Report file").grid(row=row, column=0, sticky="w")
        ttk.Entry(cfg, textvariable=self.report_file, width=60).grid(row=row, column=1, sticky="we", padx=(8, 8))
        ttk.Button(cfg, text="Browse...", command=self._browse_report).grid(row=row, column=2, sticky="w")

        row += 1
        ttk.Label(cfg, text="Concurrency").grid(row=row, column=0, sticky="w")
        ttk.Entry(cfg, textvariable=self.concurrency, width=12).grid(row=row, column=1, sticky="w", padx=(8, 0))

        ttk.Label(cfg, text="Duration (minutes)").grid(row=row, column=2, sticky="w", padx=(20, 0))
        ttk.Entry(cfg, textvariable=self.duration_minutes, width=12).grid(row=row, column=3, sticky="w", padx=(8, 0))

        row += 1
        ttk.Label(cfg, text="Snapshot size (KB)").grid(row=row, column=0, sticky="w")
        ttk.Entry(cfg, textvariable=self.snapshot_size_kb, width=12).grid(row=row, column=1, sticky="w", padx=(8, 0))

        ttk.Label(cfg, text="Snapshots per candidate").grid(row=row, column=2, sticky="w", padx=(20, 0))
        ttk.Entry(cfg, textvariable=self.snapshot_count, width=12).grid(row=row, column=3, sticky="w", padx=(8, 0))

        row += 1
        ttk.Label(cfg, text="Presence interval (sec)").grid(row=row, column=0, sticky="w")
        ttk.Entry(cfg, textvariable=self.presence_interval_sec, width=12).grid(row=row, column=1, sticky="w", padx=(8, 0))

        ttk.Label(cfg, text="Listening interval (sec)").grid(row=row, column=2, sticky="w", padx=(20, 0))
        ttk.Entry(cfg, textvariable=self.listening_interval_sec, width=12).grid(row=row, column=3, sticky="w", padx=(8, 0))

        row += 1
        ttk.Label(cfg, text="Listening actions / candidate").grid(row=row, column=0, sticky="w")
        ttk.Entry(cfg, textvariable=self.listening_actions, width=12).grid(row=row, column=1, sticky="w", padx=(8, 0))

        ttk.Label(cfg, text="Listening chunk (KB)").grid(row=row, column=2, sticky="w", padx=(20, 0))
        ttk.Entry(cfg, textvariable=self.listening_chunk_kb, width=12).grid(row=row, column=3, sticky="w", padx=(8, 0))

        row += 1
        ttk.Label(cfg, text="Play window start (min)").grid(row=row, column=0, sticky="w")
        ttk.Entry(cfg, textvariable=self.play_start_minute, width=12).grid(row=row, column=1, sticky="w", padx=(8, 0))

        ttk.Label(cfg, text="Play window end (min)").grid(row=row, column=2, sticky="w", padx=(20, 0))
        ttk.Entry(cfg, textvariable=self.play_end_minute, width=12).grid(row=row, column=3, sticky="w", padx=(8, 0))

        row += 1
        ttk.Label(cfg, text="Audio wait after play (min)").grid(row=row, column=0, sticky="w")
        ttk.Entry(cfg, textvariable=self.audio_wait_minutes, width=12).grid(row=row, column=1, sticky="w", padx=(8, 0))

        ttk.Label(cfg, text="Answer phase (min)").grid(row=row, column=2, sticky="w", padx=(20, 0))
        ttk.Entry(cfg, textvariable=self.answer_phase_minutes, width=12).grid(row=row, column=3, sticky="w", padx=(8, 0))

        row += 1
        ttk.Label(cfg, text="Submit window (min)").grid(row=row, column=0, sticky="w")
        ttk.Entry(cfg, textvariable=self.submit_window_minutes, width=12).grid(row=row, column=1, sticky="w", padx=(8, 0))

        row += 1
        ttk.Label(cfg, text="Timeout (ms)").grid(row=row, column=0, sticky="w")
        ttk.Entry(cfg, textvariable=self.timeout_ms, width=12).grid(row=row, column=1, sticky="w", padx=(8, 0))

        ttk.Label(cfg, text="Ping interval (sec)").grid(row=row, column=2, sticky="w", padx=(20, 0))
        ttk.Entry(cfg, textvariable=self.ping_interval_sec, width=12).grid(row=row, column=3, sticky="w", padx=(8, 0))

        row += 1
        ttk.Label(cfg, text="Fail-rate threshold (0..1)").grid(row=row, column=0, sticky="w")
        ttk.Entry(cfg, textvariable=self.fail_rate_threshold, width=12).grid(row=row, column=1, sticky="w", padx=(8, 0))

        ttk.Label(cfg, text="SLO p95 warn/crit (ms)").grid(row=row, column=2, sticky="w", padx=(20, 0))
        slo_p95_wrap = ttk.Frame(cfg)
        slo_p95_wrap.grid(row=row, column=3, sticky="w", padx=(8, 0))
        ttk.Entry(slo_p95_wrap, textvariable=self.slo_p95_warn_ms, width=6).pack(side=tk.LEFT)
        ttk.Label(slo_p95_wrap, text="/").pack(side=tk.LEFT, padx=4)
        ttk.Entry(slo_p95_wrap, textvariable=self.slo_p95_crit_ms, width=6).pack(side=tk.LEFT)

        row += 1
        ttk.Label(cfg, text="SLO fail warn/crit (%)").grid(row=row, column=2, sticky="w", padx=(20, 0))
        slo_fail_wrap = ttk.Frame(cfg)
        slo_fail_wrap.grid(row=row, column=3, sticky="w", padx=(8, 0))
        ttk.Entry(slo_fail_wrap, textvariable=self.slo_fail_warn_pct, width=6).pack(side=tk.LEFT)
        ttk.Label(slo_fail_wrap, text="/").pack(side=tk.LEFT, padx=4)
        ttk.Entry(slo_fail_wrap, textvariable=self.slo_fail_crit_pct, width=6).pack(side=tk.LEFT)

        row += 1
        checks = ttk.Frame(cfg)
        checks.grid(row=row, column=0, columnspan=4, sticky="w", pady=(8, 0))
        ttk.Checkbutton(checks, text="With Presence", variable=self.with_presence).pack(side=tk.LEFT, padx=(0, 12))
        ttk.Checkbutton(checks, text="With Listening", variable=self.with_listening).pack(side=tk.LEFT, padx=(0, 12))
        ttk.Checkbutton(checks, text="With Snapshots", variable=self.with_snapshots).pack(side=tk.LEFT, padx=(0, 12))
        ttk.Checkbutton(checks, text="Realistic phased flow", variable=self.realistic_flow).pack(side=tk.LEFT, padx=(0, 12))
        ttk.Checkbutton(checks, text="Enable Ping Monitor", variable=self.enable_ping).pack(side=tk.LEFT, padx=(0, 12))
        ttk.Checkbutton(checks, text="Strict exam links only (no speaking)", variable=self.strict_exam_links).pack(side=tk.LEFT)

        for c in range(4):
            cfg.columnconfigure(c, weight=1 if c == 1 else 0)

        actions = ttk.Frame(frm)
        actions.pack(fill=tk.X, pady=(10, 6))
        self.btn_run = ttk.Button(actions, text="Run Stress Test", command=self._run)
        self.btn_run.pack(side=tk.LEFT)
        self.btn_stop = ttk.Button(actions, text="Stop", command=self._stop, state=tk.DISABLED)
        self.btn_stop.pack(side=tk.LEFT, padx=(8, 0))

        self.status = tk.StringVar(value="Ready")
        ttk.Label(actions, textvariable=self.status).pack(side=tk.LEFT, padx=(16, 0))

        progress_wrap = ttk.Frame(frm)
        progress_wrap.pack(fill=tk.X, pady=(0, 8))
        self.progress_text = tk.StringVar(value="Progress: 0%")
        ttk.Label(progress_wrap, textvariable=self.progress_text).pack(side=tk.LEFT)
        self.progress_bar = ttk.Progressbar(progress_wrap, mode="determinate", maximum=100)
        self.progress_bar.pack(fill=tk.X, expand=True, side=tk.LEFT, padx=(12, 0))

        ping_wrap = ttk.Frame(frm)
        ping_wrap.pack(fill=tk.X, pady=(0, 8))
        self.ping_text = tk.StringVar(value="Ping: idle")
        self.ping_label = tk.Label(ping_wrap, textvariable=self.ping_text, anchor="w", fg="#666666")
        self.ping_label.pack(side=tk.LEFT, fill=tk.X, expand=True)

        slo_wrap = ttk.Frame(frm)
        slo_wrap.pack(fill=tk.X, pady=(0, 8))
        self.slo_text = tk.StringVar(value="SLO: no run yet")
        self.slo_label = tk.Label(slo_wrap, textvariable=self.slo_text, anchor="w", fg="#666666")
        self.slo_label.pack(side=tk.LEFT, fill=tk.X, expand=True)

        log_frame = ttk.LabelFrame(frm, text="Live Output", padding=8)
        log_frame.pack(fill=tk.BOTH, expand=True)

        self.log = ScrolledText(log_frame, wrap=tk.WORD, font=("Consolas", 10))
        self.log.pack(fill=tk.BOTH, expand=True)
        self.log.configure(state=tk.DISABLED)

    def _set_defaults(self):
        now = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        self.base_url.set("https://english4sp.stinis.ddns.net")
        self.links_file.set("")
        self.concurrency.set("114")
        self.duration_minutes.set("13")
        self.snapshot_size_kb.set("900")
        self.snapshot_count.set("2")
        self.presence_interval_sec.set("25")
        self.listening_interval_sec.set("20")
        self.listening_actions.set("1")
        self.play_start_minute.set("1")
        self.play_end_minute.set("2")
        self.audio_wait_minutes.set("5")
        self.answer_phase_minutes.set("4")
        self.submit_window_minutes.set("2")
        self.listening_chunk_kb.set("512")
        self.timeout_ms.set("30000")
        self.ping_interval_sec.set("5")
        self.fail_rate_threshold.set("1")
        self.slo_p95_warn_ms.set("2000")
        self.slo_p95_crit_ms.set("4000")
        self.slo_fail_warn_pct.set("1")
        self.slo_fail_crit_pct.set("3")
        self.report_file.set(os.path.join(self.reports_dir, f"wave_gui_{now}.json"))

    def _browse_links(self):
        p = filedialog.askopenfilename(
            title="Select links file",
            filetypes=[
                ("Excel/CSV/TXT", "*.xlsx *.xls *.csv *.txt"),
                ("All files", "*.*"),
            ],
        )
        if p:
            self.links_file.set(p)

    def _browse_report(self):
        p = filedialog.asksaveasfilename(
            title="Save report as",
            defaultextension=".json",
            filetypes=[("JSON", "*.json"), ("All files", "*.*")],
            initialdir=self.reports_dir,
        )
        if p:
            self.report_file.set(p)

    def _append_log(self, text):
        self.log.configure(state=tk.NORMAL)
        self.log.insert(tk.END, text)
        self.log.see(tk.END)
        self.log.configure(state=tk.DISABLED)

    def _validate(self):
        if not os.path.isfile(self.script_path):
            messagebox.showerror("Error", f"Missing script: {self.script_path}")
            return False
        if not self.links_file.get().strip() or not os.path.isfile(self.links_file.get().strip()):
            messagebox.showerror("Error", "Please choose a valid links Excel/CSV/TXT file.")
            return False
        if not shutil.which("node"):
            messagebox.showerror("Error", "Node.js was not found in PATH.")
            return False
        return True

    def _build_cmd(self):
        cmd = [
            "node",
            self.script_path,
            "--links",
            self.links_file.get().strip(),
            "--base-url",
            self.base_url.get().strip(),
            "--concurrency",
            self.concurrency.get().strip(),
            "--duration-minutes",
            self.duration_minutes.get().strip(),
            "--snapshot-size-kb",
            self.snapshot_size_kb.get().strip(),
            "--snapshot-count",
            self.snapshot_count.get().strip(),
            "--presence-interval-sec",
            self.presence_interval_sec.get().strip(),
            "--listening-interval-sec",
            self.listening_interval_sec.get().strip(),
            "--listening-actions",
            self.listening_actions.get().strip(),
            "--listening-chunk-kb",
            self.listening_chunk_kb.get().strip(),
            "--play-start-minute",
            self.play_start_minute.get().strip(),
            "--play-end-minute",
            self.play_end_minute.get().strip(),
            "--audio-wait-minutes",
            self.audio_wait_minutes.get().strip(),
            "--answer-phase-minutes",
            self.answer_phase_minutes.get().strip(),
            "--submit-window-minutes",
            self.submit_window_minutes.get().strip(),
            "--timeout-ms",
            self.timeout_ms.get().strip(),
            "--fail-rate-threshold",
            self.fail_rate_threshold.get().strip(),
            "--report-file",
            self.report_file.get().strip(),
        ]

        if self.with_presence.get():
            cmd.append("--with-presence")
        else:
            cmd.append("--no-presence")

        if self.with_listening.get():
            cmd.append("--with-listening")
        else:
            cmd.append("--no-listening")

        if self.with_snapshots.get():
            cmd.append("--with-snapshots")
        else:
            cmd.append("--no-snapshots")

        if self.realistic_flow.get():
            cmd.append("--realistic-flow")
        else:
            cmd.append("--simple-flow")

        if self.strict_exam_links.get():
            cmd.append("--strict-exam-links")
        else:
            cmd.append("--allow-any-link-column")

        return cmd

    def _set_running(self, running):
        self.btn_run.configure(state=tk.DISABLED if running else tk.NORMAL)
        self.btn_stop.configure(state=tk.NORMAL if running else tk.DISABLED)

    def _start_progress(self):
        try:
            mins = float(self.duration_minutes.get().strip())
        except Exception:
            mins = 13.0
        mins = max(0.1, mins)
        self.run_target_seconds = int(mins * 60)
        self.run_started_at = time.time()
        self.progress_bar.configure(value=0)
        self.progress_text.set(f"Progress: 0% (0s/{self.run_target_seconds}s)")
        self.slo_text.set("SLO: waiting for run report...")
        try:
            self.slo_label.configure(fg="#666666")
        except Exception:
            pass
        if self.progress_after_id:
            try:
                self.root.after_cancel(self.progress_after_id)
            except Exception:
                pass
            self.progress_after_id = None
        self._tick_progress()

    def _tick_progress(self):
        if self.process is None or self.run_started_at is None or self.run_target_seconds <= 0:
            return
        elapsed = max(0.0, time.time() - self.run_started_at)
        pct = min(100.0, (elapsed / self.run_target_seconds) * 100.0)
        self.progress_bar.configure(value=pct)
        self.progress_text.set(f"Progress: {pct:.1f}% ({int(elapsed)}s/{self.run_target_seconds}s)")
        self.progress_after_id = self.root.after(1000, self._tick_progress)

    def _stop_progress(self, finished_ok=False):
        if self.progress_after_id:
            try:
                self.root.after_cancel(self.progress_after_id)
            except Exception:
                pass
            self.progress_after_id = None
        if finished_ok:
            self.progress_bar.configure(value=100)
            self.progress_text.set("Progress: 100% (completed)")

    def _start_ping_monitor(self):
        if not self.enable_ping.get():
            self.ping_text.set("Ping: disabled")
            try:
                self.ping_label.configure(fg="#666666")
            except Exception:
                pass
            return
        try:
            interval = float(self.ping_interval_sec.get().strip())
        except Exception:
            interval = 5.0
        interval = max(1.0, interval)
        self.ping_stats = {
            "count": 0,
            "fail": 0,
            "min": None,
            "max": 0.0,
            "sum": 0.0,
            "last": None,
            "last_status": "-",
        }
        self.ping_stop = threading.Event()
        self.ping_thread = threading.Thread(target=self._ping_loop, args=(interval,), daemon=True)
        self.ping_thread.start()

    def _stop_ping_monitor(self):
        if self.ping_stop is not None:
            try:
                self.ping_stop.set()
            except Exception:
                pass
        self.ping_stop = None

    def _ping_loop(self, interval_sec):
        base = self.base_url.get().strip().rstrip("/")
        url = f"{base}/api/config"
        while self.process is not None and self.ping_stop is not None and not self.ping_stop.is_set():
            started = time.perf_counter()
            ms = None
            status_code = "ERR"
            ok = False
            try:
                req = urllib.request.Request(url, method="GET")
                with urllib.request.urlopen(req, timeout=10) as resp:
                    status_code = str(getattr(resp, "status", "200"))
                    _ = resp.read(64)
                    ms = (time.perf_counter() - started) * 1000.0
                    ok = True
            except Exception:
                ms = (time.perf_counter() - started) * 1000.0

            st = self.ping_stats or {}
            st["count"] = int(st.get("count", 0)) + 1
            st["last"] = ms
            st["last_status"] = status_code
            if ok:
                st["sum"] = float(st.get("sum", 0.0)) + float(ms)
                st["max"] = max(float(st.get("max", 0.0)), float(ms))
                cur_min = st.get("min")
                st["min"] = float(ms) if cur_min is None else min(float(cur_min), float(ms))
            else:
                st["fail"] = int(st.get("fail", 0)) + 1
            self.ping_stats = st

            self.root.after(0, self._refresh_ping_text)

            slept = 0.0
            while slept < interval_sec:
                if self.ping_stop is None or self.ping_stop.is_set() or self.process is None:
                    return
                chunk = min(0.25, interval_sec - slept)
                time.sleep(chunk)
                slept += chunk

    def _refresh_ping_text(self):
        st = self.ping_stats or {}
        count = int(st.get("count", 0))
        fail = int(st.get("fail", 0))
        last = st.get("last")
        status_code = st.get("last_status", "-")
        min_ms = st.get("min")
        max_ms = float(st.get("max", 0.0))
        ok_count = max(0, count - fail)
        avg_ms = (float(st.get("sum", 0.0)) / ok_count) if ok_count > 0 else 0.0
        if count == 0:
            self.ping_text.set("Ping: waiting first sample...")
            try:
                self.ping_label.configure(fg="#666666")
            except Exception:
                pass
            return
        last_txt = f"{float(last):.0f}ms" if last is not None else "-"
        min_txt = f"{float(min_ms):.0f}ms" if min_ms is not None else "-"
        self.ping_text.set(
            f"Ping: last={last_txt} status={status_code} avg={avg_ms:.0f}ms min={min_txt}ms max={max_ms:.0f}ms fail={fail}/{count}"
        )
        fail_ratio = (fail / count) if count > 0 else 0.0
        if fail_ratio >= 0.1 or avg_ms >= 3000:
            color = "#b71c1c"  # red
        elif fail > 0 or avg_ms >= 1500:
            color = "#ef6c00"  # orange
        else:
            color = "#2e7d32"  # green
        try:
            self.ping_label.configure(fg=color)
        except Exception:
            pass

    def _evaluate_slo_report(self, report_path):
        if not report_path or not os.path.isfile(report_path):
            self.slo_text.set("SLO: report not found")
            try:
                self.slo_label.configure(fg="#666666")
            except Exception:
                pass
            return

        try:
            with open(report_path, "r", encoding="utf-8") as f:
                rep = json.load(f)
        except Exception as e:
            self.slo_text.set(f"SLO: report parse failed ({e})")
            try:
                self.slo_label.configure(fg="#b71c1c")
            except Exception:
                pass
            return

        endpoints = rep.get("endpoints", {}) if isinstance(rep, dict) else {}
        critical_names = [
            "GET /api/session/:token",
            "POST /api/session/:token/listening-ticket",
            "GET /api/session/:token/listening-audio",
            "POST /api/session/:token/snapshot",
            "POST /api/session/:token/submit",
        ]

        try:
            p95_warn = float(self.slo_p95_warn_ms.get().strip())
        except Exception:
            p95_warn = 2000.0
        try:
            p95_crit = float(self.slo_p95_crit_ms.get().strip())
        except Exception:
            p95_crit = 4000.0
        try:
            fail_warn = float(self.slo_fail_warn_pct.get().strip())
        except Exception:
            fail_warn = 1.0
        try:
            fail_crit = float(self.slo_fail_crit_pct.get().strip())
        except Exception:
            fail_crit = 3.0

        worst_level = 0  # 0 green, 1 orange, 2 red
        parts = []
        seen = 0
        for name in critical_names:
            e = endpoints.get(name)
            if not isinstance(e, dict):
                continue
            seen += 1
            p95 = float(e.get("p95Ms", 0.0) or 0.0)
            fail_rate_pct = float(e.get("failRate", 0.0) or 0.0) * 100.0
            level = 0
            if p95 >= p95_crit or fail_rate_pct >= fail_crit:
                level = 2
            elif p95 >= p95_warn or fail_rate_pct >= fail_warn:
                level = 1
            worst_level = max(worst_level, level)
            parts.append(f"{name.split(' ')[1]} p95={p95:.0f}ms fail={fail_rate_pct:.2f}%")

        if seen == 0:
            self.slo_text.set("SLO: no endpoint metrics in report")
            try:
                self.slo_label.configure(fg="#666666")
            except Exception:
                pass
            return

        prefix = "SLO: OK"
        color = "#2e7d32"
        if worst_level == 1:
            prefix = "SLO: WARNING"
            color = "#ef6c00"
        elif worst_level == 2:
            prefix = "SLO: CRITICAL"
            color = "#b71c1c"

        self.slo_text.set(prefix + " | " + " ; ".join(parts[:3]))
        try:
            self.slo_label.configure(fg=color)
        except Exception:
            pass

    def _run(self):
        if self.process is not None:
            return
        if not self._validate():
            return

        cmd = self._build_cmd()
        self._append_log("\n=== START ===\n")
        self._append_log("CMD: " + " ".join([self._quote(x) for x in cmd]) + "\n\n")

        self._set_running(True)
        self.status.set("Running...")
        self._start_progress()
        self.ping_text.set("Ping: starting...")

        try:
            self.process = subprocess.Popen(
                cmd,
                cwd=self.workspace_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except Exception as e:
            self.process = None
            self._set_running(False)
            self.status.set("Failed to start")
            messagebox.showerror("Run failed", str(e))
            return

        self.reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
        self.reader_thread.start()
        self._start_ping_monitor()

    def _reader_loop(self):
        proc = self.process
        try:
            if proc and proc.stdout:
                for line in proc.stdout:
                    self.root.after(0, self._append_log, line)
        finally:
            code = None
            try:
                code = proc.wait(timeout=1) if proc else None
            except Exception:
                pass
            self.root.after(0, self._on_finished, code)

    def _on_finished(self, code):
        self.process = None
        self._set_running(False)
        self._stop_ping_monitor()
        if code == 0:
            self._stop_progress(finished_ok=True)
            self.status.set("Completed OK")
            self._append_log("\n=== FINISHED: OK ===\n")
            rf = self.report_file.get().strip()
            if rf and os.path.isfile(rf):
                self._append_log(f"Report: {rf}\n")
            self._evaluate_slo_report(rf)
        else:
            self._stop_progress(finished_ok=False)
            self.status.set(f"Finished with code {code}")
            self._append_log(f"\n=== FINISHED: EXIT {code} ===\n")

    def _stop(self):
        if not self.process:
            return
        try:
            self._stop_ping_monitor()
            self.process.terminate()
            self._append_log("\n[Stopped by user]\n")
        except Exception as e:
            self._append_log(f"\n[Stop failed: {e}]\n")

    @staticmethod
    def _quote(s):
        if not s:
            return '""'
        if any(ch.isspace() for ch in s) or any(ch in s for ch in ['"', "'"]):
            return '"' + s.replace('"', '\\"') + '"'
        return s


def main():
    root = tk.Tk()
    app = StressTestApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
