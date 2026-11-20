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
- Scalanie: **squash**, z `--match-head-commit <SHA, który przeszedł CI>`. Scalaj tylko za zgodą właściciela.
- Po CI sprawdź w logu, że **nowe testy faktycznie się wykonały**; samo SUCCESS tego nie dowodzi.
- Nie usuwaj ani nie osłabiaj testów, żeby uzyskać SUCCESS. Przy FAIL: log → przyczyna → poprawka → ponowne uruchomienie.
- Do gałęzi cudzego PR (np. PR #8) nie pushuj bezpośrednio. Otwórz PR z bazą w tej gałęzi (przykłady: #25, #27).
- Pracuj wyłącznie na syntetycznych danych i izolowanym profilu (`pl.tracker.personal.testonly`).

## Schemat SQLite

- Wersję wyznacza `LATEST_SCHEMA_VERSION` w `src-tauri/src/main.rs` (**na `main` @ `73d9e3e`, 20.11.2026: 13**). Przed każdą zmianą ponownie sprawdź wartość w kodzie; nie wpisuj na sztywno aktualnego numeru w nowych testach.
- Każda migracja: jedna transakcja, zweryfikowana kopia przed migracją (`initialise_with_backup`), walidacja w `initialise`, w preflight i przy odtwarzaniu kopii (`storage_safety::validate_database`).
- Migracja jest jednokierunkowa: starsze buildy odmawiają nowszej bazy. Zaznacz to w opisie PR.
- `sleep_periods` (v12, PR #26): okresy są chronione triggerami przed nadpisaniem i usunięciem. **Na `main` PR #29 podłączył już zdarzenia Windows suspend/resume, komendy D4 i UI `SleepPending`**, wraz z raportami i CSV. Przy brakującym/podejrzanym zdarzeniu stosuj istniejącą ścieżkę `uncertain` / ręcznego rozstrzygnięcia, nie dopisuj czasu automatycznie. Testy symulowane i Windows CI nie zastępują fizycznego suspend/resume na Windows 11.
- `entry_drafts` (v13, PR #31): szkice wpisów w lokalnym `app_data_dir/entry-drafts` i pokwitowania rozstrzygnięć w SQLite. Migracje wymagają weryfikacji i kopii; wcześniejszy build ze schematem v12 nie otworzy bazy v13. Odbiór szkiców, dialogów zamknięcia i przenoszenia danych wymaga niezależnego E2E Windows 11.

## Stan PR #8 (migawka 20.11.2026)

Duży Draft [PR #8](https://github.com/maniczko/TrackerMaster/pull/8) (gałąź `integration/mvp-hotkey-csv-restore-20261117`) jest dzielony na małe wycinki. **Nie scalać całego PR #8.** Przed pracą ponownie zweryfikuj stan PR, HEAD i różnice względem `main`.

- **Scalone do `main`:** #16 (parser czasu / DST), #17 (segmentacja snu), #18 (nagłówki CSV), #26 (schemat snu v12), **#29 (zdarzenia zasilania + `SleepPending` + raport/CSV)**, **#31 (szkice wpisów + schema v13)**. Tych wycinków nie implementuj ponownie.
- **Scalone do gałęzi PR #8 (nie do `main`):** #27 i #30 — synchronizacje po #26 i #29.
- **Otwarty Draft #32** — kolejna synchronizacja gałęzi PR #8 po #31, celem jest *gałąź PR #8*, nie `main`. HEAD sprawdzony 20.11: `333542c524325e53b28b4014b21014018661bfb4`. [GitHub Actions #44729992798](https://github.com/maniczko/TrackerMaster/actions/runs/44729992798): `build`, `windows-application`, `msix-lifecycle` — SUCCESS na tym SHA. To testy Windows CI, **nie** końcowy odbiór Windows 11 / podpisanego Store MSIX.
- **Pozostałe kandydaty do wydzielenia:** globalne skróty / ustawienia i obsługa okien, zakres i filtry raportów. Każdy wycinek wymaga samodzielnej analizy diff, testów, CI i zgody na merge.
- [PR #19](https://github.com/maniczko/TrackerMaster/pull/19) — osobny Draft miniwidgetu, zakres częściowo pokrywa się z PR #8; sprawdź różnice i nie scalaj obu niezależnie bez usunięcia duplikacji.

Nie interpretuj poprzedniego CI lub rozwiązanego konfliktu jako dowodu dla nowszego SHA. **Formalna bramka QA-01 nadal jest zablokowana** do wykonania obowiązkowych testów Windows 11 x64 i MSIX.

## Notion — statusy i dowody

- Autor przenosi kartę najwyżej do **Do weryfikacji**. **Zrobione** nadaje inny recenzent po sprawdzeniu dowodów. Agent nie jest niezależnym recenzentem własnej pracy.
- Każdy wpis: PR, SHA, link do CI, wynik (PASS/FAIL/BLOCKED/NOT RUN), środowisko, pozostałe ryzyka.
- Rozróżniaj: kod istnieje / kod w `main` / testy automatyczne PASS / odbiór na Windows 11 / formalna akceptacja. CI na Windows Server nie zastępuje odbioru na Windows 11 x64.
- Nie deklaruj zapisu w Notion ani wyniku testu, którego nie wykonano.

## Wymaga zgody właściciela

Publikacja w Microsoft Store, konto wydawcy i opłaty. Scalanie do `main`. Usuwanie gałęzi lub PR. Zmiana zatwierdzonych decyzji. Wysyłanie danych klientów. Zmiana ustawień bezpieczeństwa systemu.
