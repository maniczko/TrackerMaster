# TrackerMaster — stan zweryfikowany (migawka 23.11.2026)

> To **migawka audytowa**, nie raport na żywo. Aktualizuj wyłącznie po ponownym sprawdzeniu GitHub i Notion; dawne SHA i `SUCCESS` nie są dowodem dla nowego commita.

## Stan kodu, gałęzi i CI

| Element | Zweryfikowany stan | Dowód |
| --- | --- | --- |
| `main` | `91e2451cee4ea830c95a301b21262b116c71097c` | [commit](https://github.com/maniczko/TrackerMaster/commit/91e2451cee4ea830c95a301b21262b116c71097c) |
| SQLite | `LATEST_SCHEMA_VERSION=14` na migawce `main` | `src-tauri/src/main.rs` (nie kopiować stałej do testów) |
| PR #8 | **closed, not merged**; wycinki scalone osobno; nie traktować jako aktywnej gałęzi rozwojowej | [PR #8](https://github.com/maniczko/TrackerMaster/pull/8) |
| PR #66 | **Draft**, dokumentacja i reguły governance; 7 plików, GitHub Actions PASS na SHA `472f77dc` (przebieg 1); bez niezależnego review i bez merge. Po kolejnych poprawkach ponownie sprawdzić CI dla nowego HEAD. | [PR #66](https://github.com/maniczko/TrackerMaster/pull/66), [CI poprzedniego SHA](https://github.com/maniczko/TrackerMaster/actions/runs/45273456026) |
| PR #63 | Draft, `9445686`; tydzień kalendarza; **CI PASS**, próby 3 i 4 tego samego SHA; niezależna recenzja `COMMENTED` | [PR](https://github.com/maniczko/TrackerMaster/pull/63), [run](https://github.com/maniczko/TrackerMaster/actions/runs/45237770902) |
| PR #64 | Draft, `1c2814a`; Summary KPI/wykres/grupowanie; **CI PASS** próby 1 i 2, niezależny review nadal brak | [PR](https://github.com/maniczko/TrackerMaster/pull/64), [run](https://github.com/maniczko/TrackerMaster/actions/runs/45246425971) |
| PR #65 | Draft, `d9583de`; miesiąc; **CI PASS** tylko próba 1, niezależny review brak; bazuje na gałęzi PR #63 | [PR](https://github.com/maniczko/TrackerMaster/pull/65), [run](https://github.com/maniczko/TrackerMaster/actions/runs/45246498170) |

W powyższych przebiegach wszystkie trzy joby (`build`, `windows-application`, `msix-lifecycle`) zakończyły się `success`. Testy uruchamiano w GitHub Actions Windows (w tym Windows Server 2025 dla części E2E), na **niepodpisanych** artefaktach testowych. To nie jest odbiór końcowego MSIX w Microsoft Store ani dowód na Windows 11 właściciela.

## Backlog Notion: trzy rozłączne miary

| Rodzaj | Łącznie | Stan na migawce |
| --- | ---: | --- |
| Wymagania PTT | 60 | 59 `Do analizy`, 1 `Zablokowane`; status PTT nie oznacza, że kodu nie ma |
| Zadania TECH/DEV/QA | 55 | 5 `Zrobione`, 15 `Do weryfikacji`, 11 `W realizacji`, 24 `Zablokowane` (po aktualizacji DEV-24/25/31) |
| Decyzje D1–D13 | 13 | **Wszystkie zatwierdzone na bezpośrednio odczytanych kartach**; zapytanie zbiorcze SQL nieaktualnie pokazuje D8/D9 `Do decyzji` |

**Nie przeliczaj 5/55 ani 11/13 na procent gotowości aplikacji.** Statusy opisują proces, nie zweryfikowane pokrycie kryteriów odbioru. Zestawienie SQL z 23.11 ma niespójne wartości D8/D9; przed raportowaniem decyzji użyj bezpośredniego `fetch` kart [D8](https://app.notion.com/p/418e1de1f67a8147bc62c5feff5c0307) i [D9](https://app.notion.com/p/418e1de1f67a815eb86dea3d494a3528) zamiast wnioskować o nowych decyzjach.

## Ważne rozróżnienie MVP i V1.1

- MVP: **offline**, bez Notion, jeden timer, raport i bezpieczny CSV, backup/restore, skrót globalny; akceptacja na Windows 11 x64 (D11, D12).
- **D11 finalnie supersedes wcześniejsze NSIS/OneDrive**: MSIX przez Microsoft Store Private audience. Nie ma dowodu opublikowanego, podpisanego pakietu ani przeprowadzonego odbioru Store na Windows 11. Nie otwierać konta, nie płacić i nie publikować bez odrębnego polecenia.
- V1.1: kalendarz i rozbudowany Summary; rozpoczęto w PR #63–#65. Nie są częścią zaakceptowanego `main`, nie zamykają QA-04–QA-06. UI dark mode poza MVP.
- V1.2: Notion **import danych zadań**, bez synchronizacji wpisów czasu do Notion (D9).

## Ryzyka i następne kroki

1. **P0 — release MVP**: DEV-02/03/14/TECH-05 → podpis/Store → rzeczywisty Windows 11 x64 → DEV-15 / QA-01. Brak akceptacji QA, status `BLOCKED / NOT RUN`.
2. **P1 — governance**: statusy i opisy DEV-24/25/31 zostały uzgodnione w Notion 23.11 (`W realizacji`, SHA i dowody w kartach); nadal brak niezależnego odbioru. Kolejne zadanie: uzupełnić faktycznych prowadzących/recenzentów, dowody i wykonalne następne kroki, bez zgadywania osób ani fałszywego `PASS`.
3. **P1 — PR #63–#65**: niezależny review #64/#65, drugi zielony przebieg #65 dla dokładnego SHA, następnie integracja z zachowaniem zależności gałęzi tylko po zgodzie PO. Po rebase/merge aktualizować SHA i powtarzać testy.
4. **P1 — dokumentacja**: finalna D11/MSIX jest oznaczona nad historycznymi fragmentami QA-01; stare README i CLAUDE zachowano w archiwum Draft PR #66. Pozostaje niezależny review oraz CI dla aktualnego SHA #66, a potem ewentualne scalenie za zgodą PO.
5. **P2 — UX i wydajność**: niezależny test 100/125/150% DPI, klawiatura, 10 tys. wpisów, granice DST; benchmark performance i dostępność.

**Jakość metadanych Notion (migawka 23.11):** z 15 zadań `Do weryfikacji` żadne nie ma wpisanego `Recenzenta`; 24 zablokowane nie mają `Agenta prowadzącego`, a 22/24 nie mają wpisanych `Dowodów`; 2/5 kart `Zrobione` nie mają `Recenzenta`. Te luki to brak ścieżki audytowej, **nie dowód braku testów**. Bez zweryfikowania dowodów nie zmieniać zaakceptowanych statusów.

Podstawowy rejestr: [Notion — Personal Time Tracker](https://app.notion.com/p/418e1de1f67a8152928dfe2ccb01db64) oraz [rejestr governance](https://app.notion.com/p/421e1de1f67a812cac31e41152f49e6b). Karty i warunki odbioru są bardziej szczegółowe niż ta migawka.
