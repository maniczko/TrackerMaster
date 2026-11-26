# TECH-06 — Macierz testów i odbioru MVP TrackerMaster

**Data opracowania:** 2026-11-17; **aktualizacja:** 2026-11-23 (dowody CI i runbook Windows 11)  
**Źródła:** Notion „Backlog — Personal Time Tracker”: PTT-01–PTT-41, TECH-06, DEV-15, QA-01 oraz decyzje D1–D13; GitHub `main` bazowo `9de9f4c8209dbc1f0b0c23d3b3d6467c57b91b3a` (poprzednio `d9f70423d9cb2ffff0ed22d6308fb08c7da3de8c`).  
**Status dokumentu:** PLAN QA z finalnymi D11/D12, uzupełniony o dowody automatyczne z CI (§2a) — do niezależnego odbioru TECH-06. Statusy z CI dotyczą **runnera Windows Server w GitHub Actions** i **niepodpisanego buildu testowego**; nie są odbiorem na Windows 11 x64. Dokument nie jest protokołem odbioru DEV-15/QA-01.  
**Dowód CI (bazowy):** workflow „Windows test build”, push na `main` `9de9f4c8`, run [45162324375](https://github.com/maniczko/TrackerMaster/actions/runs/45162324375) — SUCCESS: `build` (job 137650570684: `cargo test` 137/137, node 95 + 13 + 16 = 124/124), `windows-application` (job 137655018638: `tests/windows-application.mjs` + `tests/windows-file-protection.ps1 -Mode Unpackaged`), `msix-lifecycle` (job 137655018632: `packaging/msix/Test-TestMsixLifecycle.ps1` + `tests/windows-file-protection.ps1 -Mode Packaged`). Kontrakty z filtrem ścieżek, ostatnie zielone na `main`: TECH-10 run [45035415760](https://github.com/maniczko/TrackerMaster/actions/runs/45035415760) (`7916ff9`), TECH-09 run [44255043975](https://github.com/maniczko/TrackerMaster/actions/runs/44255043975) (`2235b9a`).  
**Kryterium pokrycia:** 30 wymaganych w backlogu pozycji oznaczonych *MVP + Must* (PTT-05 i PTT-21 mają priorytet Should, więc nie są bramką Must). „Must” to priorytet wpisu, nie dowód zatwierdzonej akceptacji każdej karty PTT — właściwość Akceptacja wymaga odrębnego rozstrzygnięcia. Decyzje biznesowe D11/D12 są finalnie zatwierdzone od 17.11.2026; wykonanie DEV i QA to osobne bramki.

## 1. Środowisko, dane i zasady

- **System odbiorowy:** czysty Windows 11 x64, zwykłe konto użytkownika, ochrony Windows aktywne (w tym aktualne ustawienia Smart App Control / Code Integrity), instalacja z docelowego pakietu. Nie wyłączać ochrony w celu zaliczenia testów.
- **Aktualna decyzja dystrybucyjna D11 (17.11.2026):** *Microsoft Store, MSIX, Private audience, Free, pierwszy odbiorca = jedyne osobiste MSA właściciela*. Wcześniejsze instrukcje o NSIS należy traktować jako historyczne, a nie aktualną bramkę wydania. Konto Partner Center, paczka i prywatna grupa muszą zostać rzeczywiście skonfigurowane i niezależnie zweryfikowane; samo spisanie decyzji nie jest PASS.
- **Dane wyłącznie syntetyczne:** klient **K-A „Test Alfa”**, klient **K-B „Test Beta”**; każdy ma projekt **„Wspólny”** z odrębnymi ID oraz zadania **A1, A2, B1**. Dodatkowo wpisy datowane na **2026-03-29** i **2026-10-25** dla przejść DST w `Europe/Warsaw`. Nie używać danych realnych klientów ani produkcyjnych kont.
- **Uruchomienie:** zalogować konto standardowe, odłączyć internet w zadanych scenariuszach; zapisać architekturę, build Windows, commit, wersję aplikacji/pakietu, `user_version` SQLite, strefę IANA, hash pakietu, stan kontroli aplikacji i ścieżkę danych (bez pełnych danych konta).
- **Bezpieczeństwo testów awaryjnych:** używać tylko izolowanego profilu/VM i kopii fikcyjnej bazy. Symulować brak miejsca, przerwanie procesu, niezgodną kopię i zmianę zegara **wyłącznie** w piaskownicy. Nie niszczyć bieżących danych ani nie instalować niepodpisanej wersji przez wyłączanie zabezpieczeń.
- **Wynik testu:** `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`. `PASS` wymaga **wykonanego** scenariusza i dowodu. Testu bez docelowego sprzętu/pakietu nie oznaczać PASS; brak Must jest BLOCKED dla bramki QA-01.

## 2. Macierz: wymagania Must MVP → scenariusze

| Wymaganie | Priorytet / wersja | Testy akceptacyjne | Dowód CI (szczegóły w §2a) | Status |
|---|---|---|---|---|
| PTT-01 Uruchomienie timera | Must / MVP | T01, T02, T16 | #40, #45, #56; E2E `initial`, `hotkey-restart` | częściowo (CI) — reszta na W11 |
| PTT-02 Zatrzymanie timera | Must / MVP | T01, T02, T20 | #40, #45, #56, #58; E2E `initial`, `write-failure` | PASS (CI, Windows Server runner) |
| PTT-03 Przełączenie na inne zadanie | Must / MVP | T02 | #45, #56; E2E `verifyShortcutAfterRestart`, `verifyWriteFailure` | PASS (CI, Windows Server runner) |
| PTT-04 Globalny skrót start/stop | Must / MVP | T03 | #37, #40; E2E `verifyMiniTimer`, `verifyShortcutAfterRestart` | PASS (CI, Windows Server runner) |
| PTT-06 Konfiguracja/konflikt skrótu | Must / MVP | T03 | #37, #40; E2E `verifyOccupiedShortcut` | PASS (CI, Windows Server runner) |
| PTT-07 Praca w tle i tray | Must / MVP | T04, T21 | #35, #40, #46; E2E `verifySecondLaunch`, MSIX reaktywacja | częściowo (CI) — reszta na W11 |
| PTT-08 Widoczny stan i kontekst pomiaru | Must / MVP | T01, T04 | #40, #57; E2E `initial` | częściowo (CI) — reszta na W11 |
| PTT-09 Odzyskiwanie po awarii | Must / MVP | T05, T26 | #31, #45, #56, #58; E2E `interrupt` → `recover`, `write-failure-reopen` | częściowo (CI) — reszta na W11 |
| PTT-10 Uśpienie komputera | Must / MVP | T06, T23 | #26, #29, #50 (tylko symulacja) | NOT RUN (rzeczywisty sen); logika: CI |
| PTT-11 Lokalni klienci | Must / MVP | T07, T16 | #40; E2E `initial` | częściowo (CI) — reszta na W11 |
| PTT-12 Projekty przypisane do klienta | Must / MVP | T07 | #40; E2E `initial`; Rust `project_target_checks_parent_task_and_billing` | PASS (CI, Windows Server runner) |
| PTT-13 Zadania w projekcie | Must / MVP | T07 | #40; E2E `initial`; Rust `preserves_ids_history_references_and_enforces_project_consistency` | PASS (CI, Windows Server runner) |
| PTT-14 Archiwizacja z historią | Must / MVP | T08, T09 | #40; E2E `initial` (archiwum/przywrócenie); Rust `archive_preserves_history…` | PASS (CI, Windows Server runner) |
| PTT-16 Historia pomiarów | Must / MVP | T09 | #40, #53; E2E wszystkie fazy | PASS (CI, Windows Server runner) |
| PTT-17 Ręczny wpis czasu | Must / MVP | T10 | Rust `manual_entries_reject_overlaps…`; node `localDateTime.test.ts` | częściowo (CI) — reszta na W11 |
| PTT-18 Korekta i historia zmian | Must / MVP | T11, T26 | #31, #56, #58; E2E `verifyDraft`, `verifyDraftAfterWriteFailure` | PASS (CI, Windows Server runner) |
| PTT-19 Nakładanie się przedziałów | Must / MVP | T10, T11 | #58; Rust `corrections_keep_history_reject_conflicts…` | częściowo (CI) — reszta na W11 |
| PTT-20 Raport czasu klienta | Must / MVP | T12, T19, T24, T25 | #36, #44; E2E `initial`/`interrupt`; node `report*.test.ts` | częściowo (CI) — reszta na W11 |
| PTT-22 CSV jednego klienta | Must / MVP | T13, T22, T25 | #22, #44; E2E pobranie CSV, `verifyDuplicateClientChoices` | częściowo (CI) — reszta na W11 |
| PTT-23 Podgląd przed CSV | Must / MVP | T13, T25 | #34, #44; E2E podgląd CSV | częściowo (CI) — reszta na W11 |
| PTT-25 Kopia i odtworzenie | Must / MVP | T14 | #45; E2E `verifyRestoreRetry`; Rust `storage_safety::tests::*` | PASS (CI, Windows Server runner) |
| PTT-26 Ochrona danych/poświadczeń | Must / MVP | T15, R01, R02 | #55; `windows-file-protection.ps1` (oba tryby); R01 BLOCKED, R02 częściowo (testowy MSIX) | BLOCKED (R01: brak Store/podpisu); T15 PASS w CI |
| PTT-32 Pełne offline | Must / MVP | T16 | brak testu z odłączoną siecią | częściowo (CI) — reszta na W11 |
| PTT-33 Pojedyncza instancja | Must / MVP | T17 | #40, #55; E2E `verifySecondLaunch`; drugie konto w DEV-14 | PASS (CI, Windows Server runner) |
| PTT-34 Zmiana zegara/strefy | Must / MVP | T18, T24 | #29, #44 (symulacja, testy jednostkowe) | częściowo (CI) — reszta na W11 |
| PTT-35 Północ/granice raportu | Must / MVP | T19, T24, T25 | #16, #44, #53; node `reportTime`/`reportDay`; TECH-09 | częściowo (CI) — reszta na W11 |
| PTT-36 Błąd zapisu/brak miejsca | Must / MVP | T20, T26 | #45, #56, #58; E2E `verifyWriteFailure`; Rust `sqlite_full…`, `read_only…` | PASS (CI, Windows Server runner) |
| PTT-37 Jawne zakończenie podczas pomiaru | Must / MVP | T21 | #35, #40; Rust `exit_dialog_has_explicit_choices_and_safe_default` | częściowo (CI) — reszta na W11 |
| PTT-38 Dokładność/format eksportu | Must / MVP | T13, T19, T25 | #18, #44; E2E plik CSV; node `reportCsv.test.ts`; TECH-10 | częściowo (CI) — reszta na W11 |
| PTT-39 Bezpieczny tekst w eksporcie | Must / MVP | T22 | node `reportCsv.test.ts` (formuły); TECH-10 | częściowo (CI) — reszta na W11 |

Status wymagania = najsłabszy status jego scenariuszy T i R (wg §2a). `PASS (CI, Windows Server runner)` oznacza wykonanie w CI na niepodpisanym buildzie testowym, nie odbiór na Windows 11 x64.

**Wynik macierzy:** 30/30 pól Must MVP ma przypisany przynajmniej jeden scenariusz. To tylko pokrycie planem, NIE pokrycie wykonaniem. T01–T26 mają instrukcję poniżej, w tym T23–T26 weryfikujące skonsolidowane D11/D12. R01–R03 to dodatkowe bramki D11; nie utożsamiać ich z nowymi identyfikatorami PTT.

## 2a. Status wykonania T01–T26 i R01–R03 (dowody CI, stan na `9de9f4c8`)

Run „Windows test build” na `main`: [45162324375](https://github.com/maniczko/TrackerMaster/actions/runs/45162324375). Skróty dowodów:
- **E2E:** `tests/windows-application.mjs` w jobie `windows-application`. W nawiasie podana jest faza `runWindow` lub funkcja `verify*`; cudzysłów to linia `PASS:` z logu.
- **DEV-14:** `tests/windows-file-protection.ps1`.
- **MSIX:** `packaging/msix/Test-TestMsixLifecycle.ps1` (job `msix-lifecycle`).
- **Rust:** `cargo test` w jobie `build`. **node:** pliki `tests/*.test.*` z workflow.

Zasady oceny:
- **`PASS (CI, Windows Server runner)`** — główny przebieg scenariusza wykonało E2E na rzeczywistej aplikacji, a każdy oczekiwany wynik z §3 jest asertowany w CI (E2E, Rust lub node).
- **„częściowo (CI) — reszta na W11”** — wykonano tylko część. Brakujące elementy opisuje kolumna „Brak / do W11”.
- **`NOT RUN` / `BLOCKED`** — scenariusz wymaga rzeczywistego sprzętu, podpisanego pakietu lub Store.

Żaden status nie zastępuje odbioru na Windows 11 x64 (§7).

| Test | Dowód CI (PR → test/krok) | Status | Brak / do W11 |
|---|---|---|---|
| T01 | #40, #57: E2E fazy `initial` (Start, ≥5 s, Stop, wpis w Historii) i `interrupt` (ta sama historia po restarcie procesu); końcowe „PASS: two clients, project timers, History…” | PASS (CI, Windows Server runner) | — |
| T02 | #45, #56, #58: E2E `verifyShortcutAfterRestart` (koniec poprzedniego = początek nowego, bez duplikatów), `verifyMiniTimer` „repeated key-downs … started exactly one timer”, `verifyWriteFailure` „T20 Switch failing after the previous entry was closed rolled back completely”; Rust `switching_timer_closes_old_entry_and_starts_new_one`, `repeated_start_does_not_split_active_entry`, `invalid_switch_rolls_back_the_old_timer`, `database_failure_during_switch_rolls_back_and_retry_succeeds` | PASS (CI, Windows Server runner) | — |
| T03 | #37, #40: E2E `verifyOccupiedShortcut` „an actual shortcut conflict preserved the working old shortcut…” (inny proces zajmuje skrót, `tests/windows-occupy-hotkey.ps1`), `verifyMiniTimer` (skrót przy fokusie innego okna, `tests/windows-hotkey.ps1`), `verifyShortcutAfterRestart` (skrót po restarcie); Rust `failed_shortcut_conflict_or_save_keeps_the_old_registration`, `global_shortcut_refuses_archived_targets_and_unsupported_schema` | PASS (CI, Windows Server runner) | PTT-05 (USB, Should) poza bramką |
| T04 | #40, #46: E2E `verifySecondLaunch` „X hid the original window, second launch restored it, and active entry #3 was unchanged”; MSIX 4× „close hid the packaged window and reactivation restored the original process and window” | częściowo (CI) — reszta na W11 | otwarcie z ikony w zasobniku i widget na fizycznym pulpicie |
| T05 | #45, #49, #50: E2E `interrupt` (zabicie procesu przy aktywnym wpisie; „retained open entry #3 without assigning a duration”) → `recover` (odrzucenie końca przed startem, ręczne zakończenie) → `verify-recovery` („history showed the manually recovered entry”); Rust `recovery_requires_valid_explicit_end_and_marks_the_entry`, `recovered_timer_is_not_falsely_closed` | częściowo (CI) — reszta na W11 | krok „anuluj rozstrzygnięcie” w GUI; wymuszone zakończenie na W11 |
| T06 | #26, #29, #50: tylko symulacja — Rust `power_events::tests::notifications_record_suspend_and_resume_without_duplicate_periods`, `sleep_detection_preserves_entry_for_manual_recovery`; node `sleepPeriods.test.mjs`, `sleepTime.test.ts`; #62 (D4 krótkie uśpienie, schemat v14): Rust `sleep_periods::tests::observed_sleep_under_five_minutes_is_auto_included_and_five_minutes_or_unfinished_asks`, `power_events::tests::short_observed_sleep_is_counted_without_a_question_and_five_minutes_asks`, E2E faza `short-sleep` | NOT RUN | rzeczywisty suspend/resume Windows 11 (sprzęt/VM z S3/Modern Standby), także krótki sen < 5 min |
| T07 | #40: E2E `initial` (dwie hierarchie K-A/K-B przez GUI, restart w kolejnych fazach); Rust `project_target_checks_parent_task_and_billing`, `preserves_ids_history_references_and_enforces_project_consistency`, `renaming_keeps_relationships_and_history_and_rejects_stale_updates` | PASS (CI, Windows Server runner) | — |
| T08 | #40: E2E `initial` (archiwizacja i przywrócenie projektu i klienta z zachowaniem historii obu klientów); Rust `archive_preserves_history_and_prevents_new_timer_until_restored`, `client_archival_requires_archived_projects_and_restores_independently`, `task_archive_preserves_history_blocks_timer_and_restores_only_after_project` | PASS (CI, Windows Server runner) | — |
| T09 | #40, #53: E2E Historia we wszystkich fazach po restartach; `verifyEntryMenu` „History entry menu opens from the keyboard and by click…”; Rust `archive_preserves_history…`; node `historyFormat.test.ts`, `reportDay.test.ts` | PASS (CI, Windows Server runner) | — |
| T10 | Rust `manual_entries_reject_overlaps_and_allow_touching_boundaries`, `manual_entry_cannot_overlap_a_running_timer_or_use_an_archived_project`; node `localDateTime.test.ts` „rejects nonexistent and repeated local times on daylight saving changes” | częściowo (CI) — reszta na W11 | formularz „Dodaj czas ręcznie” w GUI |
| T11 | #31, #56, #58: E2E `verifyDraft` „validation and SQLite failures preserved the edit; retry saved exactly one revision”, `verifyWriteFailure` „T20 correction with an unwritable database…”; Rust `corrections_keep_history_reject_conflicts_and_roll_back_together`, `correcting_only_the_end_keeps_a_millisecond_start_shared_with_the_previous_entry` | PASS (CI, Windows Server runner) | — |
| T12 | #44: E2E `initial`/`interrupt` „report matched the selected client”, raport Detailed bez obcego wpisu; node `reportClientFilter.test.ts`, `reportTime.test.ts`; Rust `reports_include_full_history_but_exclude_deleted_entries`, `reports_withhold_active_projection_after_sleep_or_restart` | PASS (CI, Windows Server runner) | — |
| T13 | #3, #22, #44: E2E pobranie CSV („First window: downloaded CSV matched Report Details”: BOM, 1 wiersz klienta, sekundy = Detailed), `verifyDuplicateClientChoices` „identical client names are distinguishable and each CSV preview contains only its own entries”; node `reportCsv.test.ts`; TECH-10 | częściowo (CI) — reszta na W11 | otwarcie w polskim Excelu |
| T14 | #45: E2E `verifyRestoreRetry` „real restore failure kept the preview and data; retry created a safety backup and succeeded”; Rust `storage_safety::tests::restore_rejects_corrupt_or_newer_files_and_active_destination`, `backup_is_consistent_and_preserves_active_and_completed_entries`, `failed_backup_restore_can_be_retried_with_the_same_preview` | PASS (CI, Windows Server runner) | — |
| T15 | #55: DEV-14 `-Mode Unpackaged` „private ACLs, nothing in shared locations, no user data in diagnostics, second account isolated” (drugie konto standardowe: odmowa 34/34 elementów, własna pusta baza) i `-Mode Packaged`; build „Reject tracked SQLite data files” | PASS (CI, Windows Server runner) | — (podpisany pakiet: R01–R03); kopie nieszyfrowane — ryzyko odnotowane |
| T16 | E2E przechodzi pełny cykl (CRUD, Start/Switch/Stop, Historia, raport, CSV, restarty) bez usług sieciowych, ale z dostępem do sieci | częściowo (CI) — reszta na W11 | cały scenariusz przy odłączonej sieci |
| T17 | #40, #55: E2E `verifySecondLaunch` (druga kopia kończy się kodem 0 i przywraca okno, wpis bez zmian); DEV-14 drugie konto z osobną bazą; Rust `instance_guard_rejects_second_open_and_releases_on_drop` | PASS (CI, Windows Server runner) | — |
| T18 | tylko symulacja: Rust `clock_discrepancy_preserves_entry_for_manual_recovery`, `power_events::tests::clock_change_does_not_invent_a_resume_time`; node `reportTime.test.ts` „handles a clock rollback crossing midnight twice” | częściowo (CI) — reszta na W11 | zmiana zegara i strefy Windows w VM |
| T19 | #16, #44, #53: node `reportTime.test.ts` (23/25-godzinne dni DST, ułamkowa granica północy), `reportDay.test.ts` (wpis przez dwie północe), `reportCsv.test.ts` „exports the same contribution as the report…”; TECH-09 | częściowo (CI) — reszta na W11 | porównanie raportu miesięcznego i podglądu CSV w GUI |
| T20 | #45, #56, #58: E2E `verifyWriteFailure` w działającej aplikacji. „Niezapisywalna baza” to tam blokada zapisu SQLite: druga połączona sesja trzyma `BEGIN IMMEDIATE`, więc zapis aplikacji dostaje `SQLITE_BUSY`. Do tego wyzwalacze `RAISE(FAIL)` dla przełączenia po zamknięciu poprzedniego wpisu. Linie: „T20 Stop with an unwritable database…”, „T20 Switch with an unwritable database…”, „T20 Switch failing after the previous entry was closed rolled back completely”, „T20 retry after restoring writes saved one switch and one stop … without duplicates”, „PTT-36 write failures in the running app kept the timer and data intact…”. Baza tylko do odczytu i brak miejsca: wyłącznie testy Rust `read_only_database_keeps_timer_open_and_allows_stop_after_reopen` i `sqlite_full_during_switch_rolls_back_and_retry_keeps_boundary` | PASS (CI, Windows Server runner) | prawdziwy nośnik tylko do odczytu i pełny dysk w GUI (§7.4 krok 15) |
| T21 | #35, #40: Rust `exit_dialog_has_explicit_choices_and_safe_default` (rzeczywisty MessageBox na runnerze), `quit_dialog::tests::*`, `exit_stops_only_the_confirmed_timer_and_preserves_failed_writes`, `tray_exit_hands_unverifiable_timer_to_recovery_without_stopping_it` | częściowo (CI) — reszta na W11 | „Zakończ aplikację” z menu zasobnika na fizycznym pulpicie |
| T22 | node `reportCsv.test.ts` „escapes formula-like text without mutating original data”; TECH-10 | częściowo (CI) — reszta na W11 | otwarcie w arkuszu (Excel) |
| T23 | #29, #50: tylko symulacja — Rust `multiple_sleep_periods_remain_pending_until_individually_decided_and_match_csv`, `stopping_after_verified_sleep_preserves_individual_pending_decision`; node `sleepTime.test.ts` „D4: one hour work and two hours pending…”; #62: Rust `short_sleeps_count_once_without_a_question_and_a_five_minute_sleep_still_asks` (wiele krótkich uśpień, sumy raport/CSV), node `sleepTime.test.ts` „D4 short sleep…” | NOT RUN | rzeczywisty suspend/resume Windows 11, baner i decyzje w GUI |
| T24 | #36, #44: node `reportPresets.test.ts`, `reportFilterStorage.test.ts`, `reportTime.test.ts` „changing the report zone changes day allocation without changing total duration”; Rust `timezone_migration_preserves_history_and_uses_optimistic_updates`, `ui_preferences::tests::report_filter_migrates_once_and_keeps_the_last_valid_range` | częściowo (CI) — reszta na W11 | dialog strefy (Anuluj/Zastosuj) i błąd zapisu ustawienia w GUI |
| T25 | #18, #44: E2E plik CSV (BOM, wiersze); node `reportCsv.test.ts`; TECH-10 (rzeczywisty plik UTF-8 na Windows) | częściowo (CI) — reszta na W11 | widok w polskim Excelu, porównanie podglądu Detailed |
| T26 | #31, #56, #58: E2E `verifyDraft` „draft survived interruption, identified a concurrent change, and applied only the selected field”, „manual and automatic sort retries were counted, rate-limited…”, `verifyDraftAfterWriteFailure` „T26 … survived the failed write and the restart…”, „T26 retry saved exactly one correction…”; brak oryginału: Rust `entry_drafts::tests::creating_from_missing_source_uses_new_id_and_preserves_audit_in_backup`; node `entryDraft.test.ts` | PASS (CI, Windows Server runner) | — |
| R01 | — | BLOCKED | brak konta Partner Center i podpisanego pakietu Store (D11) |
| R02 | #46, #55: MSIX (niepodpisany pakiet testowy `TrackerMaster.TestOnly`): „Update preserved the test client and preferences.”, „Uninstall preserved the database and preferences.”, „Reinstall reopened the test profile and preserved its data.” | częściowo (CI) — reszta na W11 | to samo na podpisanym pakiecie docelowym (BLOCKED: brak podpisanego buildu) |
| R03 | — | BLOCKED | brak podpisanego pakietu; SAC na W11 nie uruchomi niepodpisanego buildu |

**Podsumowanie (9de9f4c8):**
- `PASS (CI, Windows Server runner)`: 13 scenariuszy — T01, T02, T03, T07, T08, T09, T11, T12, T14, T15, T17, T20, T26.
- Częściowo: 11 — T04, T05, T10, T13, T16, T18, T19, T21, T22, T24, T25.
- `NOT RUN`: T06, T23 (rzeczywisty sen).
- R01 i R03: `BLOCKED`; R02: częściowo.
- Według wymagań: 12/30 Must ma wszystkie scenariusze w `PASS (CI)`; 16 częściowo; PTT-10 `NOT RUN` (rzeczywisty sen); PTT-26 `BLOCKED` (R01). **Bramki DEV-15 i QA-01 pozostają zablokowane** do wykonania §7 na Windows 11 x64 z podpisanym pakietem.

## 3. Procedury szczegółowe T01–T26 (statusy wykonania: §2a)

**T01 — start/stop i stan timera (PTT-01/02/08).** Dane: K-A / Wspólny / A1, zegar Windows bez modyfikacji. Kroki: uruchom aplikację offline; wybierz K-A, projekt i zadanie; naciśnij Start; odczekaj co najmniej 5 s, sprawdź stan w głównym oknie; Stop; zamknij i uruchom ponownie. Oczekiwane: dokładnie jeden zamknięty wpis K-A, czas nieujemny odpowiada rzeczywiście upływającemu czasowi, stan „zatrzymany”, ta sama historia po restarcie; brak drugiego bieżącego pomiaru.

**T02 — atomowe przełączanie A→B i retry (PTT-01/02/03).** Dane: aktywne A1 i istniejące A2; nieistniejący taskId 999999. Kroki: Start A1; wybierz Start A2; sprawdź wpisy; powtórz ten sam Start; spróbuj przełączyć na nieistniejący/archiwalny cel; w osobnym teście wywołaj wymuszony błąd transakcji SQLite. Oczekiwane: koniec A1 = początek A2 (jedna granica czasowa), tylko jeden aktywny timer; powtórzenie nie tworzy duplikatu; błędne żądanie zachowuje A2 i wycofuje wszystkie zmiany.

**T03 — globalny skrót i konflikt (PTT-04/06).** Dane: wybrany kontekst K-A/A1, drugie okno aplikacji, inny program zajmujący skrót. Kroki: przypisz dopuszczalny skrót, aktywuj inny program, wywołaj Start/Stop; uruchom konfliktujący skrót i spróbuj zapisać konfigurację; uruchom ponownie aplikację. Oczekiwane: skrót działa globalnie tylko w przypisanym kontekście, nie uruchamia dwóch timerów; konflikt jest czytelnie sygnalizowany, bez przejęcia zajętej kombinacji; ustawienie utrzymuje się zgodnie z decyzją. Fizyczny USB PTT-05 (Should) testować osobno, nie jest bramką MVP.

**T04 — zamknięcie okna, tray, powrót (PTT-07/08/37).** Dane: aktywne A1. Kroki: zamknij główne okno przy działającym timerze; otwórz je przez tray; sprawdź widget i ponownie otwórz główne okno; spróbuj jawnie zakończyć proces z timera. Oczekiwane: zamknięcie okna nie gubi stanu; tray przywraca ten sam wpis; jawne zakończenie ma poprawny dialog, nie zamraża okien i nie gubi danych.

**T05 — crash/restart/recovery (PTT-09).** Dane: A1 pracujący 1–2 min, plik SQLite w profilu VM. Kroki: zakończ proces wymuszeniem bez Stop; uruchom ponownie, odczytaj listę nierozstrzygniętych pomiarów/szkiców; anuluj próbę rozstrzygnięcia, a następnie świadomie rozstrzygnij i uruchom ponownie. Oczekiwane: brak automatycznego dopisywania niezweryfikowanego czasu; użytkownik widzi stan wymagający decyzji; anulowanie nie usuwa szkicu; poprawne potwierdzenie tworzy co najwyżej jeden poprawny wpis i zachowuje ślad audytowy.

**T06 — rzeczywiste uśpienie i powrót (PTT-10).** Dane: timer A1, odczyty licznika czasu przed i po sleep. Kroki: włącz pomiar, uśp Windows w VM/laptopie; wybudź po kilku minutach; obejrzyj pomiar i raport/CSV przed rozstrzygnięciem; świadomie zaakceptuj lub odrzuć czas snu, sprawdź sumy. Oczekiwane: uśpienie jest jawnie oznaczone; niezaakceptowany czas nie zwiększa potwierdzonego czasu pracy ani finalnego CSV; akceptacja/odrzucenie jest jednokrotne i audytowalne. Rejestrować ograniczenia krótkiego snu/zmiany liczników. **Krótkie uśpienie (D4, decyzja PO 23.11.2026, schemat v14):** sen krótszy niż 5 min (wybudzenie − uśpienie < 300 000 ms, stała `SHORT_SLEEP_AUTO_INCLUDE_MS`) jest wliczany do pomiaru bez pytania: bez banera i listy „Uśpienie do rozstrzygnięcia”, bez stanu „Do weryfikacji”, zapis `decision='auto_included'` z `decided_ms` równym czasowi wybudzenia. Sen od 5 min wzwyż (granica włącznie) i każdy niezakończony okres: bez zmian według D4-A (pytanie, brak w CSV do decyzji). Wykonać dwa przebiegi: krótki (1–2 min) — czas wliczony w licznik, raport i CSV, brak pytania; długi (≥ 5 min) — pytanie jak wyżej. Granice 299 999 / 300 000 ms i 1 s są w testach Rust; E2E Windows (`short-sleep`) sprawdza zapis aplikacji na danych syntetycznych, nie fizyczny suspend.

**T07 — CRUD i izolacja danych (PTT-11/12/13).** Dane: K-A i K-B, w obu projekt „Wspólny”, zadania A1 i B1. Kroki: offline utwórz obie hierarchie; dodaj wpisy; spróbuj przypisać zadanie B1 do projektu K-A i sprawdzić obcy projectId; zmień nazwę jednej pozycji; restart. Oczekiwane: ID i relacje trwałe, brak cichego przenoszenia historii, nieistniejący lub obcy identyfikator jest odrzucony bez częściowego zapisu.

**T08 — archiwum klienta/projektu/zadania (PTT-14).** Dane: K-A z dwoma projektami, jeden z aktywnym timerem. Kroki: spróbuj archiwizować aktywny cel; zatrzymaj timer, archiwizuj projekt i klienta; przywróć tylko klienta, następnie jeden projekt, następnie zadanie. Oczekiwane: brak archiwizacji w trakcie aktywnego pomiaru, brak kaskadowego odarchiwizowania projektów po przywróceniu klienta, wpisy historyczne zachowane i dostępne w raportach, archiwalne pozycje nie są oferowane dla nowego Start.

**T09 — historia i trwałość (PTT-14/16).** Dane: A1/A2 i B1, co najmniej trzy zakończone wpisy. Kroki: wyświetl historię z datą/klientem/projektem/zadaniem; restart, archiwizuj zadanie, ponownie wyświetl historię. Oczekiwane: te same ID, zakresy i klient; archiwizacja nie usuwa historii.

**T10 — ręczne wpisy i overlap (PTT-17/19).** Dane: A1 09:00–10:00, drugi wpis 09:30–10:30, trzeci 10:00–11:00 i powtórzona godzina DST. Kroki: dodaj pierwszy; spróbuj nałożenia; dodaj stykający się; próbuj nieistniejącej/powtórzonej lokalnej godziny bez rozstrzygnięcia. Oczekiwane: overlap odrzucony, stykanie zaakceptowane, DST nie jest przeliczany zgadywaniem, poprzedni wpis niezmieniony.

**T11 — korekta i audyt (PTT-18/19).** Dane: A1 09:00–10:00, A2 11:00–12:00. Kroki: zmień A1 na 09:00–10:30; sprawdź historię wartości; spróbuj zmienić A1 na zakres kolidujący z A2; zasymuluj błąd zapisu. Oczekiwane: jedna udana atomowa korekta wraz z historią, nieudana korekta bez zmian i z zachowanymi wartościami. Usuwanie PTT-21 ma priorytet Should — jego regresję wykonać dodatkowo, nie zastępuje T11.

**T12 — raport klienta (PTT-20).** Dane: K-A = 2h w jednym dniu, K-B = 3h (również projekt nazwany „Wspólny”); jeden wpis usunięty, jeden aktywny, jeden pending. Kroki: filtr K-A, K-B i świadomy widok „wszyscy”; zmień okres i grupowanie; porównaj sumy z historią. Oczekiwane: K-A=2h, K-B=3h, razem 5h tylko gdy wybrano wszystkich; wpisy usunięte i niezatwierdzone nie zawyżają sum; filtr nie zmienia się sam po odświeżeniu.

**T13 — podgląd i eksport jednego klienta (PTT-22/23/38).** Dane: K-A i K-B, opisy z polskimi znakami, średnikiem, cudzysłowem i nową linią; wpis przekraczający 24h. Kroki: wybierz K-A i okres, przygotuj podgląd, porównaj ID/liczby/czasy; pobierz CSV po potwierdzeniu; otwórz w polskim Excelu i parserze CSV; próbuj odpowiedzi backendu z obcym klientem/duplikatem ID. Oczekiwane: UTF-8 BOM, separator `;`, quoting, pełne sekundy i HH:MM:SS bez modulo 24h, daty IANA; podgląd = źródło pliku, brak wpisów K-B i brak powtórzonych ID, niezgodność powoduje odmowę eksportu. Testy PR #3 są automatyczne; QA GUI pozostaje osobny.

**T14 — backup i restore (PTT-25).** Dane: dwaj klienci z historią, otwarty timer, WAL aktywny, niezależna testowa kopia SQLite. Kroki: wykonaj kopię przy aktywnym timerze, sprawdź integralność; zakończ timer; wskaż kopię, obejrzyj podgląd, anuluj, potem świadomie potwierdź; spróbuj przywrócić uszkodzoną/nowszą kopię. Oczekiwane: spójny snapshot bez brakujących wpisów, brak zmian produkcyjnej bazy przed potwierdzeniem; odmowa złej kopii bez utraty danych, kopia bezpieczeństwa przed podmianą, restart po restore, brak stale działań innych okien.

**T15 — ochrona lokalnych danych (PTT-26).** Dane: dwa osobne standardowe profile Windows; fikcyjne nazwy klientów i opisy. Kroki: zainstaluj/uruchom aplikację w profilu A, utwórz bazę i kopię; sprawdź ścieżkę i ACL, logi, pakiet/ZIP, uprawnienia dostępu profilu B; przeanalizuj politykę sekretów. Oczekiwane: brak produkcyjnych baz w repo/paczce, brak wycieku opisów/tokenów/sekretów do logów; baza w odpowiednim per-user AppData; profil B nie otrzymuje cudzej bazy. Backup nie jest domyślnie szyfrowany: odnotować ryzyko i wymagany poziom ochrony.

**T16 — pełny cykl offline (PTT-01/11/32).** Dane: obaj klienci, projekty i zadania, dzienny zestaw kilku pomiarów. Kroki: wyłącz internet przed startem; wykonaj lokalne CRUD, Start/Switch/Stop, historię, raport i CSV, restart; dopiero po teście przywróć internet. Oczekiwane: żadna kluczowa czynność MVP nie wymaga Notion/tokena ani połączenia; wszystkie ID i dane pozostają po restarcie, raport zgodny z zapisami.

**T17 — jedna instancja (PTT-33).** Dane: aktywne okno i timer K-A. Kroki: uruchom `tracker-master.exe` drugi raz w tym samym profilu; sprawdź liczbę procesów i otwarte SQLite; uruchom z drugiego standardowego profilu Windows. Oczekiwane: nie ma drugiego zapisu do tej samej bazy ani drugiego timera; pierwsza sesja pozostaje responsywna; profil B ma własną izolowaną bazę.

**T18 — zegar i strefa (PTT-34).** Dane: aktywny timer, strefa raportu Europe/Warsaw. Kroki: w VM przesuń zegar Windows w przód i wstecz, zmień strefę systemową; wróć do poprawnej daty i restart. Oczekiwane: brak ujemnego/zawyżonego czasu akceptowanego milcząco; niepewność wymaga ręcznego rozstrzygnięcia; strefa raportu nie zmienia się wskutek samej zmiany strefy komputera.

**T19 — północ, DST i precyzja (PTT-20/35/38).** Dane: wpis 23:50–00:10 przez granicę dnia; dni 29.03.2026 (23h) i 25.10.2026 (25h) w Europe/Warsaw; wpis >24h. Kroki: porównaj przypisanie sekund do lokalnych dat, raport miesięczny, podgląd CSV i sumę z pełnego wpisu. Oczekiwane: żadna sekunda nie jest podwójnie liczona; pełen przedział ma sumę części; DST liczone z faktycznego czasu, nie przez stałe 86400 s na dzień; CSV zgodne z raportem w wybranym okresie.

**T20 — błąd SQLite / brak miejsca (PTT-02/36).** Dane: aktywny timer A1, kopia bazy testowej. Kroki: w VM ustaw bazę read-only lub zasymuluj brak miejsca; spróbuj Stop/Switch/korekty; przywróć możliwość zapisu i powtórz operację. Oczekiwane: żadnego fałszywego „Zapisano”; brak utraty/duplikacji wpisów, transakcja atomowa, jednoznaczny komunikat i bezpieczne ponowienie.

**T21 — świadome zakończenie (PTT-07/37).** Dane: aktywny A1; otwarte główne okno i widget. Kroki: w tray wybierz „Zakończ aplikację”, odmów lub anuluj, a następnie zatrzymaj pomiar i zakończ; uruchom ponownie. Oczekiwane: po anulowaniu aplikacja odpowiada i timer nadal działa; po świadomym zakończeniu zapis i historia są poprawne, żadna ścieżka dialogu nie zawiesza aplikacji.

**T22 — CSV injection i polskie znaki (PTT-22/39).** Dane: nazwy i opisy rozpoczynające się `=`, `+`, `-`, `@`, tabulatorem/nową linią; `Zażółć gęślą jaźń`, `"test";` i wielowierszowy opis. Kroki: podgląd, eksport CSV, otwórz w arkuszu i zweryfikuj cytowanie; ponownie odczytaj oryginalny wpis w SQLite. Oczekiwane: żaden tekst użytkownika nie jest wykonany jako formuła, polskie znaki i nowe linie zachowane, eksport nie modyfikuje opisu źródłowego.


**T23 — wiele okresów uśpienia i decyzje po restarcie (PTT-09/10/20).** Dane syntetyczne: A1, 10:00–11:00 praca, S1 sen 11:00–12:00, praca 12:00–12:30, S2 sen 12:30–13:00, praca 13:00–14:00. Osobny przypadek: brak czasu wybudzenia. Kroki: rzeczywisty suspend/resume Windows 11 x64, identyfikacja S1/S2, odłożenie decyzji „Później”, restart, odczyt listy i banera 10 sekund, wpisanie brakującej godziny (gdy potrzeba), doliczenie wyłącznie S1, odrzucenie S2, ponowne wykonanie tej samej operacji i kolejne restarty. Oczekiwane: 2h30m pracy + 1h30m pending przed decyzją; po doliczeniu S1 — 3h30m pracy; po odrzuceniu S2 — nadal 3h30m; brak automatycznego dopisywania, podwójnego naliczenia i nadpisania granic (S1 i S2 trwają ≥ 5 min, więc reguła krótkiego uśpienia ich nie dotyczy). Dodatkowy przypadek D4 (schemat v14): S3 — krótki sen 2 min w pracy 13:00–14:00 — wliczony automatycznie, nie pojawia się na liście ani w banerze; sumy przed i po decyzjach bez zmian (2h30m pracy + 1h30m pending, potem 3h30m), bez podwójnego naliczenia S3. UI nie blokuje timera przy odroczeniu, a okres z nieznanym końcem wymaga jawnej korekty; Summary/Detailed/CSV zgodne ze stanem decyzji.

**T24 — strefa IANA, filtr dat, presety i DST (PTT-20/34/35).** Dane: źródło UTC 2026-01-31 23:30–2026-02-01 00:30 (3600 s), filtr styczniowy oraz instant referencyjny 2026-11-15 23:30Z. Kroki: wyświetl Europe/Warsaw, wybierz Europe/London i „Anuluj”, następnie „Zastosuj”; powtórz z błędem trwałego zapisu ustawienia i dla presetów „Dzisiaj”/„Ten tydzień”; sprawdź restart, powrót do Warszawy oraz daty DST. Oczekiwane: w Warszawie styczeń 0 s, luty 3600 s; w Londynie styczeń 1800 s, luty 1800 s, bez zmiany całkowitego czasu i entryId; anulowanie/błąd persist niczego nie zapisują; ręcznie wskazane daty filtra pozostają takie same, presety względne przeliczają lokalny dzień (Warszawa 16.11, Londyn 15.11); eksport i Detailed pokazują te same wkłady.

**T25 — finalny kontrakt 12 kolumn CSV (PTT-20/22/23/35/38/39).** Dane: ukończony wpis 23:30–01:30 przez północ (7200 s), dwóch klientów A/B, rozliczalne i nierozliczalne wpisy, tekst z polskimi znakami, średnikiem, cudzysłowem, nową linią oraz potencjalną formułą; czas ponad 24 h. Kroki: wygeneruj podgląd Detailed i CSV dla pojedynczego dnia, całego okresu i każdego klienta; porównaj zapisane bajty oraz widok polskiego Excela, przetestuj Europe/Warsaw i DST. Oczekiwane: dokładnie 12 zatwierdzonych polskich kolumn w kolejności: ID, klient, projekt, zadanie, opis, start, koniec, rozliczalność, całkowite sekundy, całkowite HH:MM:SS, sekundy w okresie, HH:MM:SS w okresie; 1 wiersz na oryginalny ukończony wpis; UTF-8 z pojedynczym BOM, separator średnik, cytowanie i ochrona przed CSV injection, wartości Tak/Nie, lokalne ISO8601 z offsetem, bez zaokrągleń, brak zawijania czasu po 24h. Dla pełnego wpisu 7200 s, a dla odpowiednich dni wkład 1800 s i 5400 s; bez obcych klientów, aktywnych i nierozstrzygniętych sekund w sumach. Zawartość CSV zgodna z podglądem, bez zmian w bazie źródłowej.

**T26 — szkice po awarii i preferencje sortowania (PTT-09/18/36).** Dane: formularz edycji E1, lokalny szkic, później zmodyfikowany bądź usunięty oryginał oraz dwa oczekujące szkice. Kroki: zmień formularz, odczekaj około 1 s bez wpisywania i wywołaj blur, wymuś zamknięcie procesu i restart; odłóż powiadomienie do końca sesji, sprawdź listę „Szkice (N)”, konflikt wersji E1, brak oryginału i ręczne odtworzenie nowego wpisu ze śladem pochodzenia; wybierz „Najnowsze/Najstarsze”, wykonaj restart, zasymuluj błąd persist, automatyczne ograniczone ponowienia i ręczne „Spróbuj ponownie”. Oczekiwane: szkice zachowane bez automatycznego usunięcia i bez cichego nadpisania oryginału, trwały audyt pochodzenia, poprawny porządek i zapamiętanie preferencji; przy błędzie zapisu preferencja działa w bieżącej sesji z ostrzeżeniem, a ręczne retry nie resetuje limitu automatycznych prób. Status wykonania: §2a.

## 4. Dodatkowe bramki D11 wydania Store (statusy: §2a — R01/R03 BLOCKED, R02 częściowo)

**R01 — prawdziwe MSIX i Private audience.** Dane: konto MSA właściciela (bez wpisywania adresu do dowodów), drugie niezaproszone MSA, czysty Windows 11 x64. Kroki: zweryfikuj zatwierdzony pakiet w Store, pozytywny pobór przez właściciela, negatywna próba obcego konta także z bezpośrednim linkiem. Oczekiwane: produkt Free, prywatna grupa tylko z MSA właściciela, brak nieautoryzowanego pobrania, nie rozszerzano grona testerów. Nie tworzyć konta/nie publikować bez osobnej operacyjnej autoryzacji.

**R02 — trwałość po uninstall/reinstall MSIX.** Dane: K-A/K-B, ID, wpisy, korekty, backupy, ustawienia, zapisane hashe. Kroki: na rzeczywistym podpisanym pakiecie utwórz dane, aktualizuj wersję, odinstaluj normalnie, ponownie zainstaluj w tym samym profilu; sprawdź zarówno bazę główną, jak i WAL/SHM, ID i ustawienia. Oczekiwane: dedykowany **niewirtualizowany per-user AppData** zgodnie z ostatnią decyzją D11; żadnego wyzerowania danych po normalnym uninstall; migracje zachowują wszystkie relacje i historię. Nie domniemywać tego z działania Tauri `app_data_dir` ani testu debug EXE.

**R03 — podpis i reputacja / aktualizacja.** Dane: finalny Store MSIX, hash artefaktu, wersje N i N+1, Windows 11 x64 z aktywnymi zabezpieczeniami. Kroki: zweryfikuj tożsamość/podpis Store, instalację i uruchomienie, upgrade z wpisami klientów; sprawdź zdarzenia ochrony Windows. Oczekiwane: prawidłowa sygnatura i działające uruchomienie bez wyłączenia Smart App Control; brak utraty czasu i danych po upgrade; brak sekretów/poufnych danych w artefaktach. Sam zielony `cargo test` lub `tauri build --no-bundle` = niewystarczający dowód.

## 5. Minimalny zapis wyniku (dla każdego Txx / Rxx)

| Pole | Wymagane |
|---|---|
| Test ID / wymagania | Np. `T14 / PTT-25` |
| Wykonawca i niezależny recenzent | Identyfikator, nie tajne dane konta |
| Commit / tag / SHA-256 pakietu | Konkretna testowana wersja |
| Środowisko | Windows 11 build, x64, tryb ochrony, profil, MSIX |
| Dane fikcyjne | ID klienta/projektu/wpisu i okres, bez realnych danych |
| Kroki, actual vs expected | Wypełnione podczas wykonania |
| Wynik | PASS / FAIL / BLOCKED / NOT RUN |
| Dowody | Link do logu/zdjęcia/raportu, bez sekretów |
| Defekt / ponowienie | ID zgłoszenia, data poprawki i ponowny wynik |

**Brama DEV-15:** wszystkie 30 pozycji Must muszą mieć wykonane testy, łącznie z nowymi T23–T26, bez krytycznych FAIL/BLOCKED, a scenariusze T05/T06/T13/T14/T15/T16/T20 oraz R01–R03 muszą być poparte dowodami odpowiednio do bieżącej D11. Wymaganie „niezależna QA” w QA-01 jest osobne — autor kodu nie zatwierdza samodzielnie wydania. Brak podpisanego/instalowalnego MSIX, testu realnego sleep, migracji, braku mieszania klientów lub przywracania = **BLOCKED**, a nie PASS.

## 6. Otwarte uzgodnienia i kontrola aktualności

- **D11 i D12 zatwierdzono biznesowo 17.11.2026** (Status Zrobione, Akceptacja Zatwierdzone). D11: Windows 11 x64, Microsoft Store MSIX Private audience, konto Individual i jedyne osobiste MSA właściciela, trwałe niewirtualizowane per-user AppData po uninstall/reinstall. Poprzednie NSIS/OneDrive/płatne podpisywanie to historie propozycji, nie obowiązujący kanał wydania. D12: UTC/IANA/DST, indywidualne pending, nieblokujące przypomnienia, Detailed/CSV i odzyskiwane szkice. Obie decyzje nie wymagają ponownego głosowania PO.
- Akceptacja D11/D12 nie oznacza odbioru żadnego DEV ani wykonania testów. Wiele kart PTT ma nadal Akceptacja=Propozycja. TECH-06 ocenia kompletność *planu*; QA-01/DEV-15 oceniają rzeczywiście uruchomione testy i pozostają osobne.
- Przy nowym Must zmienić macierz, dodać scenariusz i ponownie zrewidować bramkę; nie zaliczać pokrycia testem, który nie spełnia nowego kontraktu.
- Pokrycie scenariuszami = plan. Pokrycie wdrożeniem = osobny przegląd GitHub. Pokrycie wykonaniem = zarejestrowany wynik QA. Te trzy poziomy raportować oddzielnie.

## 7. Runbook odbioru Windows 11 (do wykonania po otrzymaniu podpisanego buildu)

**Warunek wejścia:** podpisany pakiet docelowy, czyli MSIX ze Store (D11) lub pakiet podpisany zaakceptowanym certyfikatem. Do tego czasu cały runbook ma status `BLOCKED` (brak podpisanego buildu). **Nie wyłączać Smart App Control ani innych zabezpieczeń**, żeby uruchomić niepodpisany build. Zasady z §1 obowiązują bez zmian.

### 7.1 Przygotowanie środowiska

1. VM lub osobny komputer z czystym **Windows 11 x64**. Zrób migawkę „przed instalacją”, żeby móc powtarzać scenariusze destrukcyjne (T05, T18, T20).
2. Dwa konta **standardowe** (bez uprawnień administratora): **QA-A** (główne) i **QA-B** (T15, T17). Administrator służy tylko do zmiany zegara lub strefy (T18) i skalowania (UIQ-09). Aplikację uruchamia zawsze konto standardowe.
3. Strefa systemowa `Europe/Warsaw`. Format regionalny polski (dla Excela w T13, T22, T25). Do T13/T22/T25 potrzebny jest Excel lub inny arkusz z polskimi ustawieniami.
4. Zainstaluj pakiet z docelowego kanału (R01/R03): w Store przez zaproszone MSA właściciela, w pozostałych przypadkach podpisany MSIX.

### 7.2 Metadane do zapisu przed testami (bez danych kont)

| Pole | Jak odczytać (tylko odczyt) | Wartość |
|---|---|---|
| Build Windows / architektura | `winver` lub `Get-ComputerInfo -Property OsName,OsBuildNumber,OsArchitecture` | |
| Commit / tag źródła | SHA z opisu wydania (np. `9de9f4c8` + kolejne) | |
| Wersja i nazwa pakietu | `Get-AppxPackage *TrackerMaster*` → `Version`, `PackageFullName` | |
| SHA-256 pakietu | `Get-FileHash -Algorithm SHA256 <plik .msix>` (przy instalacji z pliku) lub identyfikator przesyłki Store | |
| Stan Smart App Control | Zabezpieczenia Windows → Kontrola aplikacji i przeglądarki → Smart App Control (Włączone/Ewaluacja/Wyłączone). Tylko zapisać, **nie zmieniać** | |
| Strefa systemowa i raportu | `Get-TimeZone`; w aplikacji: Raport → strefa raportowania | |
| Ścieżka danych | `C:\Users\<konto>\AppData\Roaming\pl.tracker.personal`, sprawdzona w Eksploratorze po pierwszym starcie. Dla MSIX według D11 ma to być ta sama, niewirtualizowana ścieżka. Jeśli dane trafiają do `C:\Users\<konto>\AppData\Local\Packages\<PFN>\LocalCache\Roaming\pl.tracker.personal`, zapisz faktyczną ścieżkę i oznacz R02 jako FAIL | |
| `user_version` SQLite | Panel „Kopia zapasowa” → „Utwórz kopię”. Na **kopii** (nie na bazie roboczej) odczytaj nagłówek SQLite, bajty 60–63 big-endian: `$b=[IO.File]::ReadAllBytes('<ścieżka kopii>'); [BitConverter]::ToInt32(@($b[63],$b[62],$b[61],$b[60]),0)`. Oczekiwane `LATEST_SCHEMA_VERSION` z commitu (13 na `9de9f4c8`). „Sprawdź bazę” pokazuje tylko liczności. | |
| Wykonawca / niezależny recenzent | identyfikatory (§5) | |

### 7.3 Dane syntetyczne

Jak w §1: **K-A „Test Alfa”** i **K-B „Test Beta”**, w każdym projekt **„Wspólny”** (odrębne ID). Zadania **A1, A2** (K-A) i **B1** (K-B). Wpisy z 2026-03-29 i 2026-10-25 do testów DST w `Europe/Warsaw`. Do T13, T22 i T25: opisy z polskimi znakami (`Zażółć gęślą jaźń`), średnikiem, cudzysłowem, nową linią i początkiem `=`, `+`, `-`, `@`. Żadnych danych prawdziwych klientów.

### 7.4 Kolejność scenariuszy

Szczegółowe kroki i pełne oczekiwane wyniki są w §3. Każdy wynik zapisz według §5. W kolumnie „Dowód” wpisz nazwę pliku zrzutu lub logu (np. `T05-recovery-banner.png`, `T13-csv-excel.png`, `T20-error.png`) albo link.

| Krok | Scenariusz | Działanie (skrót) | Oczekiwany wynik (skrót; pełny w §3) | Dowód | Wynik |
|---|---|---|---|---|---|
| 1 | R03, R01 | Instalacja z docelowego kanału; drugie, niezaproszone MSA próbuje pobrać | Podpis prawidłowy, uruchomienie przy aktywnym SAC; obcy MSA nie pobiera | | |
| 2 | T16 (otwarcie) | **Odłącz sieć** przed pierwszym startem; kroki 3–12 wykonuj offline | Brak wymagań sieci w kluczowych czynnościach | | |
| 3 | T07 | Utwórz K-A/K-B, projekty, zadania; restart | ID i relacje trwałe, obce przypisanie odrzucone | | |
| 4 | T01, T02 | Start A1 ≥5 s, Stop; Start A1 → Start A2; restart | Jeden wpis na pomiar, wspólna granica, jeden aktywny timer | | |
| 5 | T03 | Ustaw skrót, użyj go przy innym oknie na pierwszym planie; konflikt z innym programem; restart | Działa globalnie, konflikt czytelny, stary skrót zachowany | | |
| 6 | T04, T21 | X przy aktywnym A1 → przywróć z **ikony w zasobniku**; widget; „Zakończ aplikację” → Anuluj, potem Stop i zakończ | Stan zachowany; po Anuluj timer trwa; brak zawieszenia | | |
| 7 | T17 | Drugi start `TrackerMaster` z menu Start przy otwartej aplikacji | Wraca istniejące okno, brak drugiego procesu/timera | | |
| 8 | T08, T09 | Archiwizacja/przywracanie zadania, projektu, klienta; Historia | Historia nienaruszona, archiwum blokuje nowy Start | | |
| 9 | T10, T11 | Ręczne wpisy z nakładaniem i stykaniem; korekta i konflikt; godzina DST | Overlap odrzucony, stykanie OK, jedna rewizja na korektę | | |
| 10 | T12, T19, T24 | Raport K-A/K-B/wszyscy; północ, 23/25-godzinne dni; zmiana strefy raportu (Anuluj/Zastosuj), presety, restart | Sumy zgodne z §3 T12/T19/T24 | | |
| 11 | T13, T22, T25 | Podgląd i CSV dla K-A; otwarcie w polskim Excelu | 12 kolumn, BOM, `;`, brak wykonania formuł, brak K-B, zgodność z podglądem | | |
| 12 | T16 (zamknięcie) | Restart offline; potem **przywróć sieć** | Dane i raport zgodne po restarcie | | |
| 13 | T05 | Wymuś zakończenie procesu przy aktywnym A1 (Menedżer zadań); restart; anuluj, potem rozstrzygnij | Brak automatycznego dopisania czasu, jeden wpis po decyzji | | |
| 14 | T26 | Edycja wpisu bez zapisu → wymuszone zamknięcie → restart → „Szkice (N)”; konflikt wersji; sortowanie | Szkic zachowany, bez nadpisania oryginału, preferencja zapamiętana | | |
| 15 | T20 | Wyłącznie na **migawce VM**; po teście przywróć migawkę. **(a) Tylko do odczytu:** start A1, zakończ proces w Menedżerze zadań (wpis zostaje otwarty, jak w T05). Przy zamkniętej aplikacji: `attrib +R "C:\Users\<QA-A>\AppData\Roaming\pl.tracker.personal\tracker.sqlite3"`. Uruchom aplikację, spróbuj rozstrzygnąć lub zakończyć wpis, Switch i korektę. Potem zamknij aplikację, `attrib -R …`, uruchom ponownie i rozstrzygnij wpis raz. Atrybut ustawiany przy działającej aplikacji nie działa na już otwarty uchwyt SQLite, dlatego tylko przy zamkniętej. **(b) Brak miejsca:** konto administratora tworzy mały dysk VHDX (np. 64 MB, `New-VHD`/Zarządzanie dyskami, litera `Z:`). Przy zamkniętej aplikacji przenieś katalog danych QA-A na `Z:\tm-data` i utwórz łącze `mklink /J "C:\Users\<QA-A>\AppData\Roaming\pl.tracker.personal" Z:\tm-data`. Uruchom aplikację, start A1, wypełnij dysk (`fsutil file createnew Z:\filler <rozmiar>` do ~0 B wolnego). Spróbuj Stop, Switch i korekty, usuń `Z:\filler`, ponów | (a) aplikacja odmawia startu z czytelnym komunikatem albo każdy zapis kończy się błędem bez zmiany danych. (b) Błąd bez fałszywego „Zapisano”. W obu: aktywny wpis bez zmian, brak duplikatów, jedno udane ponowienie po przywróceniu zapisu | | |
| 16 | T14 | Kopia przy aktywnym timerze; Stop; przywróć z podglądem (Anuluj, potem Potwierdź); zła i nowsza kopia | Kopia bezpieczeństwa przed podmianą, odmowa złej kopii | | |
| 17 | T18 | Konto administratora: zegar w przód i w tył, zmiana strefy systemowej; powrót i restart | Brak cichego ujemnego/zawyżonego czasu; strefa raportu bez zmian | | |
| 18 | T06, T23 | **Rzeczywisty sen/wybudzenie** (Start → Zasilanie → Uśpij); scenariusz S1/S2 z §3 T23; „Później”, restart, decyzje; osobno krótki sen 1–2 min (D4, schemat v14) | Sen jawnie oznaczony, pending poza sumą do decyzji, sumy jak w §3; krótki sen < 5 min wliczony bez pytania i bez banera, sen ≥ 5 min pyta | | |
| 19 | T15 | Konto QA-B: uruchom aplikację; w Eksploratorze i PowerShell spróbuj otworzyć `C:\Users\<QA-A>\AppData\Roaming\pl.tracker.personal` (dla MSIX: ścieżka zapisana w §7.2), w tym `tracker.sqlite3` i `backups\` | Odmowa dostępu; QA-B ma własną pustą bazę w `C:\Users\<QA-B>\AppData\Roaming\pl.tracker.personal` | | |
| 20 | R02 | Aktualizacja do N+1, odinstalowanie, ponowna instalacja (QA-A) | Baza, kopie, ustawienia i ID zachowane | | |
| 21 | UIQ-09 | Skalowanie 100%, 125%, 150% (Ustawienia → System → Ekran); główne okno, mini timer, dialogi, raport | Brak obciętych tekstów i poziomego przewijania, cele ≥24×24 px, czytelne etykiety; zrzut na każdą skalę | | |
| 22 | Dostępność | **Narrator** (Ctrl+Win+Enter): licznik, Start/Stop, wyszukiwarka projektu, menu ⋯ w Historii, dialogi zamknięcia/szkicu | Nazwy i stany ogłaszane, logiczna kolejność fokusu, Escape zwraca fokus | | |

**Poza MVP:** tryb ciemny (dark mode) — decyzja PO z 23.11.2026, przeniesiony do V1.1. Nie testować go jako bramki; ewentualne obserwacje zapisać jako informacyjne.

### 7.5 Kryteria zamknięcia DEV-15 / QA-01

- Wszystkie 30 pozycji Must z §2 mają wykonane scenariusze na Windows 11 x64 z podpisanym pakietem i wynik `PASS`. Status „częściowo (CI)” z §2a nie wystarcza.
- T05, T06, T13, T14, T15, T16, T20 oraz R01–R03 mają dowody (zrzut lub log) według §5.
- Brak krytycznych `FAIL`/`BLOCKED`. Każdy defekt ma zgłoszenie i ponowny wynik.
- UIQ-09 (125%/150%) i Narrator bez blokujących usterek (UIQ). Dark mode nie jest kryterium (V1.1).
- Niezależny recenzent QA potwierdza wyniki. Autor kodu nie zatwierdza wydania samodzielnie (QA-01).

## 8. Rozszerzenie V1.1 — PTT-61 / DEV-39 (Bezczynność i przypomnienia)

- **Dowody automatyczne CI (bez fizycznego Windows 11):**
  - **Rust (`attention::tests::*`, `attention_settings::tests::*`, `sleep_periods::tests::*`, `power_events::tests::*`):** `I01–I15c`, `I17–I25` (progi 5–60 min, przycinanie początku, zawijanie ticków `u32`, skok zegara, spójność z D4 / wyjątek O5a, `stop_timer_at_idle_start`, D3 Stop/Switch, odzyskiwanie po awarii, harmonogram i DST `Europe/Warsaw`, długi pomiar 4h/8h, uszkodzony `attention-settings.json`, brak zakazanych importów Win32).
  - **Node (`tests/attentionSchedule.test.ts`, `tests/designTokens.test.mjs`):** reguły harmonogramu IANA DST 23/25h, komunikaty PL, zgodność z tokenami UIQ.
  - **E2E CI (`tests/windows-application.mjs`, faza `idle-reminders`):** zapis ustawień `attention-settings.json`, okres `idle` i `sleep` w jednej transakcji, odróżnienie „Bezczynność” i „Uśpienie” na liście i w sumach (Historia / Raport / CSV), oraz `stop_timer_at_idle_start`.
- **Runbook odbioru na Windows 11 x64 (`BLOCKED` do fizycznego wykonania):** W1–W10 z `docs/TECH-12-IDLE-AND-REMINDERS.md` §5.2 (rzeczywista 15-min bezczynność myszy/klawiatury, `Win+L` z PIN-em, sesja RDP, uśpienie S3/Modern Standby + O5a, powiadomienia Windows z pakietu MSIX i Focus Assist).

