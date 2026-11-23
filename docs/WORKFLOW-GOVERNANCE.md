# TrackerMaster — zarządzanie backlogiem, PR i dowodami

Wersja: 1.0 (23.11.2026). Proces porządkujący stan realizacji, **bez zmiany zatwierdzonych decyzji D1–D13**.

## Hierarchia źródeł

| Pytanie | Źródło rozstrzygające |
| --- | --- |
| Co należy zbudować, w której wersji? | Zatwierdzone decyzje i karta PTT/DEV/TECH/QA w Notion. Późniejsza decyzja PO ma pierwszeństwo przed historyczną notatką. |
| Czy kod jest w produkcyjnej bazie kodu? | Stan `main` + SHA. Otwarty Draft PR nie jest kodem na `main`. |
| Czy test przeszedł? | GitHub Actions / log dla **dokładnego SHA**, job i wykonany test, a nie sam opis PR. |
| Czy użytkownik może instalować i rozliczać czas? | Niezależny odbiór docelowego Windows 11 x64, DEV-15/QA-01, decyzja o wydaniu i dystrybucji. |
| Czy dokument opisuje aktualny stan? | Data + zakres migawki; dokumenty archiwalne są oznaczone jako archiwum. |

## Co oznacza status Notion

| Status | Kiedy stosować |
| --- | --- |
| `Do analizy` | Nie ma pełnego zakresu lub kryteriów; dotyczy często wymagania PTT i **nie neguje** implementacji w podzadaniach |
| `Gotowe do realizacji` | Wymagania i zależności pozwalają rozpocząć |
| `W realizacji` | Rzeczywiste prace prowadzone, np. kod na gałęzi Draft PR; bloker merge/QA wpisz w **Bloker** i utrzymaj relacje |
| `Do weryfikacji` | Autor dostarczył zmianę/dowody, ale brak niezależnej akceptacji lub docelowego QA |
| `Zablokowane` | Nie można wykonać następnego właściwego etapu; wpisz dokładnie zależność i co ją odblokuje. Nie wnioskować automatycznie, że żaden kod nie istnieje. |
| `Zrobione` | Niezależnie potwierdzone AC i wymagane dowody; dla decyzji tylko akceptacja wyboru biznesowego, NIE kodu ani QA |
| `Do decyzji` | Faktycznie brak zatwierdzonej decyzji — w razie konfliktu SQL i strony Notion odczytaj bezpośrednio kartę |

Dla każdego zadania aktualizuj istniejące pola: `Status`, `Bloker`, `Dowody`, `Recenzent`, `Poprzedniki`, `Wersja`. Nie dodawaj duplikatu karty zadań w drugim backlogu. Stosuj etykiety `MVP`, `V1.1`, `V1.2` do planu produktu; **Must/Should** to waga wymagania, **P0/P1/P2** to kolejność prac.

## Minimalny kontrakt dowodowy

W polu `Dowody` zapisuj:
- ID zadania i PR oraz **dokładny HEAD SHA**, gałąź bazowa i ewentualne zależności.
- Co jest wdrożone na `main`, a co nadal na Draft PR.
- Konkretne GitHub Actions `run_id` / `run_attempt`, status każdego wymaganego joba i wynik nowego testu.
- System testowy (Windows Server w CI vs Windows 11 x64), wersję pakietu, profil i czy podpisany.
- `PASS / FAIL / BLOCKED / NOT RUN` dla kryterium; link do logu, artefaktu i defektu.
- Kto wykonał niezależny review oraz jakie warunki nadal otwarte.

**Zakaz fałszywego PASS**: przygotowanie testu ≠ jego uruchomienie; zielone `build` ≠ zainstalowana aplikacja; Windows Server CI ≠ Windows 11 użytkownika; zatwierdzona D11/D12 ≠ ukończona DEV/QA.

## Orkiestracja prac

1. Przeczytaj Notion, `main`, istniejące PR i najnowszy raport; nie implementuj funkcji drugi raz.
2. Rozdziel zależności i stany: **analiza**, **kod w Draft PR**, **scalone do main**, **CI PASS**, **niezależne review**, **docelowe E2E**, **akceptacja PO**.
3. Uzgodnij zakres małego PR, testy i akceptację; nie mieszaj migracji, UI i pakowania w jedną niepodzielną zmianę.
4. Autor otwiera Draft PR, wskazuje SHA, dodaje test i uruchamia CI; jeżeli zmieni SHA, wcześniejsze zielone przebiegi wymagają ponownej weryfikacji.
5. Recenzent niezależny od autora sprawdza diff, wyniki logów i regresje. Wybór `Zrobione` należy do niezależnej weryfikacji, nie do autora.
6. Zmiany można scalać **wyłącznie po aktualnej wyraźnej zgodzie właściciela**. Po merge zaktualizuj `main` SHA i Notion; nie używaj starych head SHA jako dowodu nowego stanu.
7. Przed wydaniem wykonaj `DEV-15 → QA-01` na docelowym Windows 11 x64, offline oraz z podpisanym pakietem Store. `NOT RUN` i `BLOCKED` pozostają otwarte.

## Zasady bezpieczeństwa i granice zakresu

- Nie wyłączać zabezpieczeń Windows dla uruchomienia niepodpisanego EXE; żadnych testów na danych klientów.
- D11: obowiązuje **MSIX / Store Private audience** dla prywatnego pilota, nie historyczne NSIS/OneDrive. Konto wydawcy, opłaty, publikacja i dostęp do private audience wymagają osobnej zgody.
- D1: Notion nie blokuje MVP offline. D9: V1.2 to import zadań; brak zapisu czasu do Notion.
- D8: drugi komputer w MVP przez ręczną kopię/restore, bez równoległej synchronizacji.
- Fizyczny przycisk USB nie jest warunkiem Must MVP. Konfigurowalny globalny skrót — jest.
- Rozbudowany kalendarz/raporty V1.1 i dark mode nie stają się Must MVP przez otwarcie PR.

## Rejestr rozbieżności (stan 23.11.2026)

- **Notion D8/D9**: bezpośrednie karty mają `Zrobione / Zatwierdzone`; SQL z 23.11 zwrócił `Do decyzji`. Nie nadpisuj decyzji na podstawie SQL — najpierw potwierdź odczyt, a rozbieżność zgłoś.
- **QA-01 — oznaczenie wykonane**: dodano na początku karty jednoznaczny zapis, że finalna D11 MSIX/Store zastępuje historyczne NSIS. Formalne testy Windows 11 pozostają otwarte; historycznych treści nie usuwano.
- **DEV-24/25/31 — uzgodnione**: statusy tych kart zmieniono na `W realizacji` z dowodami dokładnych SHA i CI odpowiednio PR #63/#65/#64. Integracja i niezależny QA nadal są zablokowane; nie przenosić kart do `Zrobione` bez odbioru.
- **README/CLAUDE — zmiany przygotowane, nie scalone**: nowe wersje i archiwum istnieją w [Draft PR #66](https://github.com/maniczko/TrackerMaster/pull/66), natomiast `main` ma wcześniejszą wersję do czasu zgody na scalenie.

## Otwarty dług związany z jakością metadanych

- Migawka Notion 23.11.2026: 15/15 kart `Do weryfikacji` nie ma wpisu w polu `Recenzent`; 2/5 kart `Zrobione` również. Brak wpisu nie dowodzi braku wykonanej recenzji — należy odszukać źródłowy dowód, uzupełnić prawdziwą osobę albo jawnie oznaczyć `nieustalony`; **nie wpisywać fikcyjnych recenzentów**.
- 24/24 kart `Zablokowane` nie mają pola `Agent prowadzący`; 22/24 nie mają pola `Dowody`. Zanim zmienisz status, sprawdź kod, PR i poprzedniki, zapisz następny wykonalny krok oraz realny bloker. Brak dowodu pozostaje brakiem, nie `PASS`.
- Rozbieżność D8/D9 SQL wobec bezpośredniego odczytu Notion pozostaje otwarta; na czas diagnostyki do raportów decyzji korzystaj z bezpośrednich kart.
- Nazwiska właścicieli/recenzentów oraz wynik QA wymagają rzeczywistego potwierdzenia; aktualizacja statusu na podstawie samego istnienia PR może oznaczać tylko `W realizacji`.

## Raport okresowy

Raportuj **cztery osobne miary**: liczbę decyzji formalnie zatwierdzonych, liczbę zadań formalnie zaakceptowanych, liczbę zmian na `main` z CI oraz rzeczywisty postęp kryteriów Must MVP/QA. Nie używaj samego `Zrobione/128` jako procentu gotowości. Przy każdym raporcie podaj datę, SHA i powody `BLOCKED`.

Zależności szczegółowe i aktualne dowody: [PROJECT-STATUS](PROJECT-STATUS.md), [QA-MVP-ACCEPTANCE-MATRIX](QA-MVP-ACCEPTANCE-MATRIX.md).
