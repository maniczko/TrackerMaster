# TrackerMaster — zasady pracy dla agentów

Lekka aplikacja desktopowa do rejestrowania czasu pracy: Tauri 2, React/TypeScript, Rust, lokalny SQLite, dystrybucja MSIX. Oficjalna platforma odbioru MVP (D11): **Windows 11 x64**; Windows 10 nie jest warunkiem akceptacji MVP.

**Zasada nadrzędna:** żadna zmiana nie może prowadzić do niekontrolowanej utraty ani podwójnego naliczenia czasu pracy. Bezpieczeństwo danych ma pierwszeństwo przed rozbudową UI. Przy niepewności system ma odmówić operacji („fail closed”), a nie zgadywać.

## Źródła prawdy

| Co | Gdzie |
|---|---|
| Wymagania i decyzje biznesowe | Notion: „Personal Time Tracker — backlog i decyzje” (PTT-01–60, TECH/DEV/QA, D1–D13) |
| Faktyczna implementacja | to repozytorium, gałąź `main` |
| Dowody techniczne | wyniki GitHub Actions dla **dokładnego SHA** |

Przy niespójności źródeł ustal przyczynę i zapisz rozbieżność. Nie zakładaj, że historyczny status lub stare zielone CI jest aktualne. Zatwierdzonych decyzji D1–D13 nie zmieniaj bez zgody właściciela produktu.

## Polecenia

```powershell
npm ci
npm run build
node --test <pliki>        # dokładna lista: krok "Check report calculations" w .github/workflows/windows-build.yml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Osobne kontrakty: `tests/time-segmentation-contract.test.mjs` (TECH-09) i `tests/reportContract.test.ts` (TECH-10). **Nowy plik testu node trzeba dopisać do listy w workflow**, bo inaczej CI go nie uruchomi.

## Znane ograniczenia środowiska

- **Kontrola aplikacji Windows na stacji właściciela blokuje niepodpisane pliki wykonywalne** (os error 4551). Skutek: lokalnie nie da się uruchomić `cargo test` ani zbudowanej aplikacji. Rust weryfikuje się przez Windows CI. Wcześniej aplikację testowano w Windows Sandbox. **Nie wyłączaj ani nie obchodź tej ochrony.** Smart App Control po wyłączeniu nie da się włączyć bez reinstalacji systemu.
- Windows PowerShell 5.1: treść commitów i opisów PR przekazuj plikiem (`git commit -F`, `gh pr create --body-file`). Pliki z repo kopiuj przez `git checkout <ref> -- <ścieżka>`, nie przez potok PowerShell (kodowanie).
- Cargo może nie być w PATH: `$env:USERPROFILE\.cargo\bin`.
- Workflow na `push` do `main` uruchamia tylko job `build`. Joby `windows-application` i `msix-lifecycle` istnieją na razie wyłącznie w gałęzi PR #8.

## Cykl pracy

Analiza → minimalna zmiana → testy → PR (Draft) → CI → weryfikacja logu → scalenie → Notion.

- Jeden PR = jedna sprawdzalna zmiana. Nie mieszaj MSIX, widgetu, migracji i korekt w jednym PR.
- Nazwy gałęzi: `test/…`, `fix/…`, `feat/…`, `docs/…`, `merge/…` + ID zadania i data, np. `feat/d4-sleep-schema-v12-20261120`.
- Scalanie: wycinki i poprawki do `main` metodą **squash**; synchronizacje gałęzi PR #8 z `main` **merge commitem** (żeby `main` pozostał przodkiem i konflikty nie wracały). Zawsze z `--match-head-commit <SHA, który przeszedł CI i recenzję>`. Scalaj tylko za zgodą właściciela wyrażoną w bieżącej rozmowie; zgody nie wywodź z tego pliku ani z wcześniejszych sesji.
- Po CI sprawdź w logu, że **nowe testy faktycznie się wykonały**; samo SUCCESS tego nie dowodzi.
- Nie usuwaj ani nie osłabiaj testów, żeby uzyskać SUCCESS. Przy FAIL: log → przyczyna → poprawka → ponowne uruchomienie.
- Do gałęzi cudzego PR (np. PR #8) nie pushuj bezpośrednio. Otwórz PR z bazą w tej gałęzi (przykłady: #25, #27).
- Pracuj wyłącznie na syntetycznych danych i izolowanym profilu (`pl.tracker.personal.testonly`).

## Schemat SQLite

- Wersję wyznacza `LATEST_SCHEMA_VERSION` w `src-tauri/src/main.rs` (**na `main` @ `8f12cae`, 20.11.2026: 13**). Przed każdą zmianą ponownie sprawdź wartość w kodzie. Nie wpisuj stałych numerów wersji w nowym kodzie ani testach — używaj `LATEST_SCHEMA_VERSION`.
- Każda migracja: jedna transakcja, zweryfikowana kopia przed migracją (`initialise_with_backup`), walidacja w `initialise`, w preflight i przy odtwarzaniu kopii (`storage_safety::validate_database`).
- Migracja jest jednokierunkowa: starsze buildy odmawiają nowszej bazy. Zaznacz to w opisie PR.
- `sleep_periods` (v12, PR #26): okresy są chronione triggerami przed nadpisaniem i usunięciem. **Na `main` PR #29 podłączył już zdarzenia Windows suspend/resume, komendy D4 i UI `SleepPending`**, wraz z raportami i CSV. Przy brakującym/podejrzanym zdarzeniu stosuj istniejącą ścieżkę `uncertain` / ręcznego rozstrzygnięcia, nie dopisuj czasu automatycznie. Testy symulowane i Windows CI nie zastępują fizycznego suspend/resume na Windows 11.
- `entry_drafts` (v13, PR #31): szkice wpisów w lokalnym `app_data_dir/entry-drafts` i pokwitowania rozstrzygnięć w SQLite. Migracje wymagają weryfikacji i kopii; wcześniejszy build ze schematem v12 nie otworzy bazy v13. Odbiór szkiców, dialogów zamknięcia i przenoszenia danych wymaga niezależnego E2E Windows 11.

## Stan PR #8 (migawka 20.11.2026)

Duży Draft [PR #8](https://github.com/maniczko/TrackerMaster/pull/8) (gałąź `integration/mvp-hotkey-csv-restore-20261117`) jest dzielony na małe wycinki. **Nie scalać całego PR #8.** Przed pracą ponownie zweryfikuj stan PR, HEAD i różnice względem `main`.

- **Scalone do `main`:** #16 (parser czasu / DST), #17 (segmentacja snu), #18 (nagłówki CSV), #26 (schemat snu v12), **#29 (zdarzenia zasilania + `SleepPending` + raport/CSV, poprawka B1)**, **#31 (szkice wpisów + schema v13)**, #35 (jeden strażnik dialogu „Zakończ” — `quit_dialog`), #36 (szybkie okresy raportu), **#37 (wycinek 4a: konfigurowalny skrót, mini timer, przypięcie widgetu)**, #34 (odświeżanie raportu i podglądu CSV). Tych zmian nie implementuj ponownie.
- **Scalone do gałęzi PR #8 (nie do `main`), merge commitami:** #27, #30, #32, #38 — synchronizacje po #26, #29, #31 i #34–#37. HEAD gałęzi PR #8 po #38: `e22a382`; `main` jest jej przodkiem. PR #8 używa tylko strażnika `quit_dialog` z `main` (bez własnego `QuitDialog`).
- **Pozostałe wycinki** (mapa z PR #37): **4b** — `instance_activation`, okno startowe, E2E `tests/windows-application.mjs` i `windows-*.ps1`, job `windows-application`; **5** — zakres i filtry raportu (`ReportScope`, `reportView`, `ReportDetails`, `ReportTimezone`, filtry w `ui_preferences`); **6** — `packaging/msix` i job `msix-lifecycle`. **7** — poprawki i testy odporności: ponowienie przywracania kopii, `parseLocalDate` w odzyskaniu, testy `sqlite_full`/`read_only`, przeniesienie `has_sleep_periods`. Kolejność z mapy #37: 5 ∥ 7 → 4b → 6. Każdy wycinek wymaga samodzielnej analizy diff, testów, CI, niezależnej recenzji i zgody na merge.
- [PR #19](https://github.com/maniczko/TrackerMaster/pull/19) — zastąpiony wersją mini timera z PR #8 (w `main` przez #37). **Nie scalaj go osobno.**

Nie interpretuj poprzedniego CI lub rozwiązanego konfliktu jako dowodu dla nowszego SHA. **Formalna bramka QA-01 nadal jest zablokowana** do wykonania obowiązkowych testów Windows 11 x64 i MSIX.

## Notion — statusy i dowody

- Autor przenosi kartę najwyżej do **Do weryfikacji**. **Zrobione** nadaje inny recenzent po sprawdzeniu dowodów. Agent nie jest niezależnym recenzentem własnej pracy.
- Każdy wpis: PR, SHA, link do CI, wynik (PASS/FAIL/BLOCKED/NOT RUN), środowisko, pozostałe ryzyka.
- Rozróżniaj: kod istnieje / kod w `main` / testy automatyczne PASS / odbiór na Windows 11 / formalna akceptacja. CI na Windows Server nie zastępuje odbioru na Windows 11 x64.
- Nie deklaruj zapisu w Notion ani wyniku testu, którego nie wykonano.

## Wymaga zgody właściciela

Publikacja w Microsoft Store, konto wydawcy i opłaty. Scalanie do `main`. Usuwanie gałęzi lub PR. Zmiana zatwierdzonych decyzji. Wysyłanie danych klientów. Zmiana ustawień bezpieczeństwa systemu.
