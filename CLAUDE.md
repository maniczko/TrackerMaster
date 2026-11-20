# TrackerMaster — zasady pracy dla agentów

Lekka aplikacja desktopowa Windows 10/11 do rejestrowania czasu pracy: Tauri 2, React/TypeScript, Rust, lokalny SQLite, dystrybucja MSIX.

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

- Wersję wyznacza `LATEST_SCHEMA_VERSION` w `src-tauri/src/main.rs` (na `main`: 12). Nie wpisuj stałych numerów wersji w nowym kodzie ani testach.
- Każda migracja: jedna transakcja, zweryfikowana kopia przed migracją (`initialise_with_backup`), walidacja w `initialise`, w preflight i przy odtwarzaniu kopii (`storage_safety::validate_database`).
- Migracja jest jednokierunkowa: starsze buildy odmawiają nowszej bazy. Zaznacz to w opisie PR.
- `sleep_periods` (v12): okresy są niezmienne i nieusuwalne (triggery). Na `main` nic ich jeszcze nie zapisuje. Rejestracja zdarzeń zasilania wchodzi dopiero **razem** z UI rozstrzygania (`SleepPending`), bo otwarty okres blokuje Stop.

## Stan PR #8

Duży Draft (`integration/mvp-hotkey-csv-restore-20261117`) dzielony na wycinki. Nie scalaj go w całości.

- Wydzielone: #16, #17, #18 (wcześniej), #26 (schemat v12 sleep).
- Następne wycinki:
  1. Zdarzenia zasilania + projekcja aktywnego pomiaru + komendy + `SleepPending` + sen w raportach i CSV — razem.
  2. Szkice wpisów (schemat v13).
  3. Skróty, okno i preferencje.
  4. Zakres raportów.
- PR #19 (mini timer) jest zdublowany przez nowszą wersję w PR #8. Nie scalaj go osobno.

## Notion — statusy i dowody

- Autor przenosi kartę najwyżej do **Do weryfikacji**. **Zrobione** nadaje inny recenzent po sprawdzeniu dowodów. Agent nie jest niezależnym recenzentem własnej pracy.
- Każdy wpis: PR, SHA, link do CI, wynik (PASS/FAIL/BLOCKED/NOT RUN), środowisko, pozostałe ryzyka.
- Rozróżniaj: kod istnieje / kod w `main` / testy automatyczne PASS / odbiór na Windows 11 / formalna akceptacja. CI na Windows Server nie zastępuje odbioru na Windows 11 x64.
- Nie deklaruj zapisu w Notion ani wyniku testu, którego nie wykonano.

## Wymaga zgody właściciela

Publikacja w Microsoft Store, konto wydawcy i opłaty. Scalanie do `main`. Usuwanie gałęzi lub PR. Zmiana zatwierdzonych decyzji. Wysyłanie danych klientów. Zmiana ustawień bezpieczeństwa systemu.
