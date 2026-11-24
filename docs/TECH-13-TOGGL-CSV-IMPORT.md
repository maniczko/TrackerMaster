# TECH-13 — analiza: import historii z Toggl Track (CSV)

**Status:** analiza techniczna do recenzji (24.11.2026). Wymaganie: [PTT-62](https://app.notion.com/p/422e1de1f67a811ba910ef88ef86da0b), karta: [TECH-13](https://app.notion.com/p/422e1de1f67a81b29b4dff1dfb647c10). Zakres zatwierdził właściciel produktu 24.11.2026.

**Czego ten dokument nie robi:** nie zmienia kodu aplikacji, schematu, testów ani workflow. Nie jest odbiorem PTT-62. Implementacja to DEV-40, rozpisana w §9.

**Baza analizy:** `main` @ `f2a3386`, `LATEST_SCHEMA_VERSION = 14`. Decyzje: D5, D7, D10 i D12 (skonsolidowany kontrakt z 17.11.2026). Wzorce: PTT-28 („blokuj do wyjaśnienia”), DEV-13 (kopia i przywracanie), PTT-36/T27 (pełny dysk).

**Zasada nadrzędna:** import dodaje dane, niczego nie nadpisuje. Każda wątpliwość oznacza odrzucenie wiersza albo całego pliku, z podaniem powodu. Nie zgadujemy.

Synthetic fixture: [`docs/fixtures/toggl-detailed-synthetic.csv`](fixtures/toggl-detailed-synthetic.csv). Wszystkie dane są fikcyjne, a domena e-mail to zarezerwowane `example.invalid`.

---

## 1. Format eksportu Toggl „Detailed” (CSV)

### 1.1 Co potwierdza oficjalna dokumentacja Toggl

Źródła odczytano 24.11.2026; pełna lista jest w §10.

| Temat | Ustalenie | Źródło |
|---|---|---|
| Eksport | Raport Detailed ma przycisk eksportu do PDF, CSV i Excel. Eksport CSV/Excel to funkcja płatnych planów. | [S1] |
| Kolumny w UI | W raporcie Detailed można ukrywać kolumny i dodawać nowe. Dokumentacja **nie mówi**, czy eksport odzwierciedla widoczne kolumny. | [S1] |
| Zakres danych | Zwykły użytkownik eksportuje własne wpisy albo wpisy projektów, którymi zarządza; administrator eksportuje wszystkie. | [S2] |
| Format czasu trwania | Format czasu trwania ustawia się w profilu i wpływa na eksport. API eksportu ma `duration_format`: `classic` (domyślny), `decimal` lub `improved`. | [S2], [S5] |
| Format daty i godziny | Ustawia się w profilu, nie w raporcie. Opcja `date_format` (m.in. `YYYY-MM-DD`, `DD.MM.YYYY`) jest opisana **tylko dla PDF**. | [S1], [S5] |
| Ponowny import | Przewodnik importu Toggl zaleca format czasu trwania „Improved” przed eksportem raportu Detailed do ponownego importu. Pośrednio wynika z tego, że kolumny eksportu Detailed są zgodne z formatem importu Toggl. | [S3] |
| Strefa czasowa | Filtry dat w API raportów działają w strefie profilu autora wpisu (UTC, gdy jej brak). API wpisów (JSON) podaje `start`/`stop` w UTC. Strefy znaczników w pliku CSV dokumentacja **nie opisuje**. | [S5], [S6] |
| Trwający pomiar | W API JSON trwający wpis ma ujemny `duration`, a `stop` może być pusty. Czy taki wpis trafia do eksportu CSV, dokumentacja **nie mówi**. | [S6] |
| Format importu Toggl (dla porównania) | Nagłówki: `User, Email, Client, Client External Reference, Project, Project External Reference, Task, Description, Billable, Start date, Start time, Duration, Tags`. Kolejność dowolna. Przecinek, UTF-8, limit 1 MB. Billable: `y/n`, `yes/no`, `1/0`. Koniec wpisu wylicza się ze startu i czasu trwania. | [S3], [S4] |
| Limity | Dokumentacja nie podaje limitów wierszy, zakresu dat ani rozmiaru eksportu. Podaje jedynie limity zapytań API. | [S7] |

### 1.2 Czego nie da się potwierdzić z dokumentacji

Dokumentacja **nie potwierdza** następujących elementów eksportu Detailed:

- dokładnych nazw i kolejności kolumn, w tym czy jest `End date`/`End time` (czy `Stop …`) oraz `Amount`;
- kodowania (UTF-8? z BOM?) i separatora;
- cytowania pól i znaków końca linii;
- rzeczywistego formatu daty, godziny i czasu trwania w pliku;
- strefy znaczników czasu;
- zapisu wartości billable (`Yes/No`?) i separatora tagów w komórce;
- obecności kolumny ID wpisu;
- obecności trwających pomiarów;
- wpływu zaokrąglania z raportu na eksport.

Fixture zakłada **roboczy** układ: `User, Email, Client, Project, Task, Description, Billable, Start date, Start time, End date, End time, Duration, Tags`. Przyjmuje też przecinek, `YYYY-MM-DD`, `HH:MM:SS` i `Yes/No`. To założenie projektowe, nie fakt z dokumentacji.

**Warunek przed scaleniem pierwszego PR DEV-40 (decyzja O1):** właściciel przekazuje **sam wiersz nagłówka** prawdziwego eksportu, bez wierszy danych. Do tego dochodzi opis ustawień profilu (format daty, godziny, czasu trwania, strefa). Prawdziwego eksportu nie commitujemy ani nie wysyłamy nigdzie. Sprawdza go wyłącznie właściciel, na własnym komputerze (§8.3).

### 1.3 Projekt parsera: nagłówki zamiast pozycji, fail closed

Zasady pliku:

- **Kodowanie:** wyłącznie UTF-8. Jeden opcjonalny BOM `EF BB BF` jest dozwolony. Odrzucamy cały plik przy niepoprawnych sekwencjach UTF-8, BOM UTF-16/32 lub bajcie `NUL`. Komunikat: „Zapisz plik jako UTF-8”.
- **Separator:** przecinek (format Toggl). Wiersz nagłówka musi się poprawnie rozdzielić na znane kolumny. Plik zapisany ponownie w polskim Excelu (średnik, zmienione daty) odrzucamy, z podpowiedzią „użyj oryginalnego pliku z Toggl”.
- **Cytowanie:** RFC 4180, czyli `"` z podwajaniem; pola mogą zawierać przecinki i nowe linie. Akceptujemy rekordy kończone CRLF i LF, a w opisie normalizujemy CRLF do LF. Odrzucamy niedomknięty cudzysłów i niezgodną liczbę pól w rekordzie.

Nagłówki rozpoznajemy po nazwie, na zamkniętej liście aliasów, np. `End date` | `Stop date`. Listę zamykamy po decyzji O1.

| Kolumna | Wymagana | Użycie |
|---|---|---|
| `Client`, `Project` | tak | mapowanie (§2) |
| `Task` | nie | mapowanie; brak = wpis bez zadania |
| `Description` | tak | opis; ≤ 2000 znaków, reguły `valid_description` |
| `Start date`, `Start time`, `End date`, `End time`, `Duration` | tak | czas (§3) |
| `Billable` | nie | per wpis. Gdy brakuje kolumny, wszystkie wpisy dostają `false` (D12: brak wartości oznacza false), z ostrzeżeniem w podglądzie. Gdy kolumna jest, ale wartość nieznana, wiersz jest odrzucany. |
| `Tags` | nie | §1.4 |
| `User`, `Email` | nie | wyłącznie kontrola jednej osoby: więcej niż jedna wartość odrzuca cały plik. Tych danych nie zapisujemy. |
| inne (`Amount`, stawki, pola własne) | — | ignorowane i wymienione w podglądzie jako „pominięte kolumny” |

Odrzucamy też cały plik, gdy: kolumna się powtarza, brakuje kolumny wymaganej albo kolumna jest pusta.

- **Data i godzina:** wymagamy `YYYY-MM-DD` oraz `HH:MM:SS` w formacie 24-godzinnym. Innych formatów nie zgadujemy: `03/04/2026` może oznaczać marzec albo kwiecień. Plik w innym formacie odrzucamy z instrukcją ustawienia profilu Toggl (decyzja O7).
- **Czas trwania:** `H+:MM:SS`, gdzie godzin może być więcej niż 24. Format dziesiętny (`1.50`) odrzucamy, bo traci sekundy, a AC1 wymaga zgodności co do sekundy.
- **Billable:** `Yes/No`, bez rozróżniania wielkości liter. Po potwierdzeniu nagłówka (O1) dopuszczamy ewentualnie `y/n`, `1/0`, tak jak w imporcie Toggl.

### 1.4 Tagi (TrackerMaster nie ma tagów)

| Wariant | Skutek |
|---|---|
| **A (rekomendacja)** | Tagi nie trafiają do opisu ani do raportów. Podgląd pokazuje, ile wpisów ma tagi i jaka jest lista unikalnych tagów. Surowa wartość trafia do metadanych importu (`imported_entries.source_tags`, §4), więc nic nie ginie bez śladu, a przyszła funkcja tagów może z niej skorzystać. |
| B | Tagi dopisywane do opisu (`… [tagi: a, b]`). Zmienia to treść opisów, może przekroczyć limit 2000 znaków i miesza dane z metadanymi. |

---

## 2. Mapowanie klient → projekt → zadanie po nazwie

Nazwy porównujemy dokładnie, po `trim` tak jak w `valid_name`: 1–200 znaków, bez znaków sterujących. Hierarchię zachowujemy ściśle (D7): projekt szukamy **tylko w obrębie** dopasowanego klienta, a zadanie tylko w obrębie projektu. Dwa „Projekt Orion” u różnych klientów to dwa różne projekty. Fixture ma ten przypadek celowo.

| Sytuacja | Wynik |
|---|---|
| Dokładnie jeden obiekt o tej nazwie (aktywny) | użyj jego ID |
| Brak obiektu | **utwórz nowy**. Podgląd wymienia go na liście „Nowi klienci / projekty / zadania”. Tworzymy tylko obiekty używane przez wiersze przyjęte do importu. |
| Więcej niż jeden obiekt o tej nazwie w bazie (np. dwóch klientów „Klient A”) | **blokuj do wyjaśnienia** (PTT-28): wszystkie wiersze tej gałęzi odrzucone z powodem „Wymaga mapowania: niejednoznaczna nazwa”. Nigdy „pierwszy z brzegu”. |
| Nazwa różni się tylko wielkością liter lub spacjami od istniejącej (w bazie albo w pliku) | blokuj: „Wymaga mapowania: podobna nazwa”. Nie tworzymy prawie-duplikatu. |
| Dopasowany obiekt jest w archiwum | odrzuć: „Projekt/klient/zadanie w archiwum” (O3). Nie przywracamy automatycznie, bo D12 wymaga świadomego przywrócenia. |
| Brak projektu (`Project` puste) | odrzuć: „Brak projektu — wpis do wyjaśnienia”. D5 i D12 wymagają klienta i projektu, a PTT-28 zakazuje przypisania do klienta ostatniego lub domyślnego. |
| Projekt bez klienta (`Client` puste) | odrzuć: „Brak klienta” (O2). |
| Brak zadania | przyjmij jako wpis bez zadania (`task_id = NULL`, dozwolone od schematu v11) |

Nowe projekty nie są domyślnie rozliczalne. Rozliczalność importowanych wpisów pochodzi wyłącznie z kolumny `Billable` i trafia do `billable_entries` dla każdego wpisu osobno. To inne zachowanie niż `insert_manual_in`, gdzie wartość domyślna pochodzi z projektu.

---

## 3. Czas: strefa, DST, północ, nakładanie, wartości zero i ujemne

1. **Strefa źródła.** Plik nie zawiera strefy (§1.2). Przed sprawdzeniem pliku użytkownik **jawnie wybiera** strefę IANA, w której Toggl wyeksportował czas (strefa profilu Toggl). Domyślnie jest to bieżąca strefa raportowa TrackerMaster (D12: domyślnie `Europe/Warsaw`). Podgląd pokazuje, z jaką strefą przeliczono dane. Zmiana strefy unieważnia podgląd.
2. **Zapis.** Każdy wpis to jeden `time_entries` z instancjami UTC (`…Z`) co do sekundy, tak jak wpis ręczny (`parse_manual_range`). Wpis przez północ **nie jest dzielony** (D12.1): segmentację na dni robi raport (`reportByDay`, TECH-09). Fixture, wiersz 5: 23:30 → 01:30, czyli 1800 s + 5400 s.
3. **Rozstrzyganie lokalnego czasu przy DST** (fail closed). Dla startu i końca wyznaczamy wszystkie instancje UTC odpowiadające lokalnej dacie i godzinie w strefie źródła. Przyjmujemy wiersz tylko wtedy, gdy **dokładnie jedna** para (start, koniec) daje `koniec − start = Duration`.
   - **Nieistniejąca godzina** (29.03.2026 02:30 w `Europe/Warsaw`) → odrzuć: „Godzina nie istnieje w wybranej strefie — sprawdź strefę”. Fixture, wiersz 8.
   - **Dwuznaczna godzina** (25.10.2026 02:00–02:59 występuje dwa razy). Gdy czas trwania wskazuje jedną parę, przyjmij ją. Fixture, wiersz 6: 01:30 → 02:30 przy `02:00:00` daje 7200 s, koniec 01:30Z. Gdy pasują dwie pary, odrzuć: „Niejednoznaczny czas przy zmianie czasu”. Fixture, wiersz 7.
   - Wiosna, wiersz 9: 01:00 → 03:30 przy `01:30:00` daje 5400 s. Zegar ścienny pokazuje 2,5 h, ale rzeczywiście minęło 1,5 h.
4. **Spójność.** `koniec − start ≠ Duration` → odrzuć „Niezgodny czas trwania” (tolerancja 0 s, O8). Fixture, wiersz 15. Zaokrąglanie w raporcie Toggl trzeba wyłączyć przed eksportem (instrukcja w UI).
5. **Zero, ujemne, brak końca, przyszłość.** Odrzucamy:
   - czas zerowy (wiersz 12; `end <= start` jest odrzucane jak przy wpisie ręcznym);
   - czas ujemny;
   - pusty koniec lub czas trwania, czyli pomiar trwający w Toggl (wiersz 18);
   - koniec w przyszłości względem zegara komputera.
6. **Nakładanie (D10)** na przedziałach półotwartych `[start, end)`. Styk 10:30/10:30 jest dozwolony (wiersze 1–2).
   - **W pliku:** wszystkie wiersze grupy, która się nakłada, są odrzucane, także gdy dotyczą różnych klientów (D10 obowiązuje per użytkownik). Fixture, wiersze 10–11. Nie wybieramy „zwycięzcy”, bo to byłoby zgadywanie.
   - **Z bazą:** porównanie z każdym nieusuniętym wpisem, także z historycznymi kolizjami (D10: nie usuwać). Aktywny timer traktujemy jako otwarty do nieskończoności, jak w `ensure_no_overlap`. Wpisy o zerowej długości w bazie pomijamy, jak w `ensure_no_overlap`. Odrzucony zostaje wiersz importu, z odwołaniem do kolidującego wpisu (data i godzina, bez ujawniania innych pól).
   - **Wydajność:** `ensure_no_overlap` skanuje całą tabelę przy każdym wpisie, co przy 10 000 × 10 000 daje O(N·M). Import ładuje przedziały raz, sortuje je i sprawdza zamiatając (O((N+M) log)). Test parzystości z `ensure_no_overlap` na tych samych danych jest obowiązkowy (§8).
7. **Kolejność reguł** (decyduje o raportowanym powodzie): plik → format wiersza → czas/DST → mapowanie → odcisk (duplikat w pliku lub wcześniej zaimportowany) → nakładanie w pliku → nakładanie z bazą. Każdy wiersz dostaje dokładnie jeden status: `do importu`, `już zaimportowany` albo `odrzucony: <kod>`.

---

## 4. Idempotencja

**Odcisk wpisu** to SHA-256 z kanonicznego zapisu UTF-8 pól oddzielonych `U+001F`:

`toggl-csv/v1 ␟ start UTC (RFC 3339, sekundy) ␟ koniec UTC ␟ czas trwania [s] ␟ klient ␟ projekt ␟ zadanie ␟ opis (CRLF→LF) ␟ billable ␟ tagi (posortowane)`

Liczymy go z **wartości źródłowych po rozstrzygnięciu strefy**, nie z bieżących nazw w bazie. Dlatego:

- Ponowny import tego samego pliku (AC2) daje `0 nowych`, `N już zaimportowanych`, a odrzucone wiersze zostają odrzucone z tymi samymi powodami.
- Zmiana nazwy klienta lub projektu w TrackerMaster po imporcie (D12 „jak Toggl”, wariant B) nie psuje rozpoznania. Korekta godzin zaimportowanego wpisu też nie, bo odcisk jest związany z `entry_id`.
- Zmiana w Toggl i ponowny eksport (np. nowa nazwa) daje inny odcisk. Wiersz nakłada się jednak na już zaimportowany wpis, więc zostaje **odrzucony z powodu nakładania**, a nie zdublowany. Podwójne naliczenie jest wykluczone na dwa niezależne sposoby.
- Zaimportowany, a potem usunięty wpis (`entry_deletions`) nie wraca przy ponownym imporcie. Status: „wcześniej zaimportowany (usunięty)” (O9).
- Dwa identyczne wiersze w jednym pliku: oba odrzucone, „Powtórzony wiersz w pliku” (fixture, wiersze 16–17).

Dodatkowo zapisujemy SHA-256 całego pliku. Ten sam plik daje w podglądzie informację „ten plik zaimportowano <data>”, ale ocena per wiersz i tak się odbywa, bo eksporty z różnych zakresów mogą się zazębiać.

**Schemat:** wymaga **nowej wersji schematu** (`LATEST_SCHEMA_VERSION` + 1, obecnie 14 → 15) i migracji z weryfikowaną kopią (`initialise_with_backup`). Walidacja w `initialise`, w preflight i przy odtwarzaniu kopii. Migracja jest jednokierunkowa: starszy build nie otworzy bazy po migracji.

```sql
CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL CHECK(source='toggl-csv'),
  file_sha256 TEXT NOT NULL, source_time_zone TEXT NOT NULL, imported_at TEXT NOT NULL,
  rows_total INTEGER NOT NULL, rows_imported INTEGER NOT NULL,
  rows_already_imported INTEGER NOT NULL, rows_rejected INTEGER NOT NULL,
  backup_file TEXT NOT NULL);                      -- nazwa pliku kopii, bez ścieżki
CREATE TABLE imported_entries (
  entry_id INTEGER PRIMARY KEY REFERENCES time_entries(id),
  batch_id INTEGER NOT NULL REFERENCES import_batches(id),
  fingerprint TEXT NOT NULL UNIQUE, source_row INTEGER NOT NULL,
  source_tags TEXT NOT NULL DEFAULT '');
-- triggery: brak UPDATE/DELETE (ślad audytowy), jak w sleep_periods
```

Alternatywa odrzucona: rozpoznawanie duplikatów tylko po identycznym przedziale czasu, bez tabeli. Ponowny import pokazałby wtedy N „konfliktów nakładania” zamiast „już zaimportowane”, co jest mylące i nie spełnia AC2 w duchu „0 nowych, bez fałszywych błędów”.

---

## 5. Podgląd (dry-run) przed zapisem

Wzorzec pochodzi z przywracania kopii (`prepare_backup_restore` → token → `apply_backup_restore`):

1. `prepare_toggl_import(bytes, source_time_zone)`: parsowanie i walidacja w Rust, **bez zapisu**. Zwraca token i plan.
2. `apply_toggl_import(token, confirmed)`: kopia, potem transakcja (§6). Wewnątrz transakcji plan jest **wyliczany ponownie**, a jego skrót porównywany z zatwierdzonym podglądem. Różnica (np. w międzyczasie dodano wpis) oznacza przerwanie, zero zmian i komunikat „Dane zmieniły się od podglądu — sprawdź plik ponownie”.

Podgląd pokazuje (wartości dla fixture w nawiasach):

- Wierszy w pliku (18). Do importu (7) i ich łączny czas (10:30:30 = 37 830 s), w tym rozliczalny (05:45:30 = 20 730 s). Już zaimportowanych (0). Odrzuconych (11), pogrupowanych po powodzie.
- Zakres dat wpisów do importu, w strefie źródła (29.03.2026 – 17.11.2026, `Europe/Warsaw`).
- Nowi klienci (2), projekty (3) i zadania (2), z rodzicem, np. „Projekt Orion — Klient Beta (fikcyjny)”. Osobno istniejące obiekty, do których trafią wpisy.
- Pominięte dane: tagi w 2 wpisach (3 unikalne), pominięte kolumny, ostrzeżenie o braku kolumny `Billable`.
- Tabela odrzuceń (§7) oraz jasna informacja, że przed zapisem powstanie kopia bazy.

**Przycisk:** „Importuj 7 wpisów”, aktywny dopiero po zaznaczeniu potwierdzenia. Przy 0 wpisów do importu jest nieaktywny i pokazuje komunikat „Nic do zaimportowania”, nigdy „sukces”.

---

## 6. Bezpieczeństwo danych

| Wymaganie | Rozwiązanie |
|---|---|
| Kopia przed zapisem (DEV-13) | `storage_safety::create_backup`: `VACUUM INTO`, preflight, publikacja dopiero po weryfikacji, w `app_data_dir/backups`. Brak kopii = **import odmówiony**, zero zmian. Ścieżka kopii trafia do wyniku i do `import_batches.backup_file`. |
| Jedna transakcja | `BEGIN IMMEDIATE`, potem nowi klienci, projekty i zadania, wpisy, `billable_entries`, `entry_descriptions`, `imported_entries`, `import_batches`, a na końcu `COMMIT`. Każdy błąd oznacza `ROLLBACK`. Nie ma importu „w częściach” (por. O6). |
| Błąd = zero zmian (AC3) | Test wstrzykuje błąd w połowie: trigger `RAISE(FAIL)` na N-tym `imported_entries`. Baza musi być identyczna (liczby, sumy, katalog), a kopia musi istnieć i przejść preflight. |
| Pełny dysk (PTT-36/T27) | Kopia nie zmieści się → odmowa przed transakcją (częściowy plik `*.partial` jest usuwany, jak dziś). `SQLITE_FULL` w transakcji → rollback i komunikat „Brak miejsca na dysku. Import nie zapisał żadnych zmian.” Po zwolnieniu miejsca ponowienie importuje dokładnie raz, co zapewnia idempotencja. Kopie się kumulują (nie ma retencji): podgląd pokazuje rozmiar bazy jako przybliżony rozmiar kopii. |
| Złośliwe lub uszkodzone pliki | Limit rozmiaru i liczby wierszy, sprawdzany w UI (`File.size`) **i** w Rust (`bytes.len()`). Propozycja: 10 MB i 50 000 wierszy, ok. 5× historia wieloletnia jednej osoby (O5). Do tego limity długości pola (opis 2000, nazwy 200), liczby kolumn (≤ 64) i długości rekordu. Odrzucamy niepoprawny UTF-8, NUL i UTF-16. Parser bez rekurencji i bez wykonywania czegokolwiek. Brak zależności od rozszerzenia pliku: decyduje treść. |
| Formuły CSV | Wartości zapisujemy **bez zmian** (to dane, nie formuły). Ochronę stosujemy przy każdym zapisie CSV: istniejący eksport już poprzedza `=+-@` i znaki sterujące apostrofem (`src/reportCsv.ts`). Fixture, wiersz 4 (`=SUMA(A1:A9)`), i test: po imporcie eksport CSV zawiera `'=SUMA(A1:A9)`. React wyświetla tekst bez interpretacji HTML. |
| Izolacja klientów (D7) | Mapowanie projektu tylko w obrębie klienta. Import nie zmienia reguł eksportu (CSV tylko dla jednego `clientId`). Test: istniejący „Projekt Orion” klienta B nie przejmuje wierszy klienta A. Raport odrzuceń pokazuje wyłącznie dane z importowanego pliku. Kopie są nieszyfrowane, co jest znaną granicą D7; UI to komunikuje, tak jak przy zwykłej kopii. |
| Brak wysyłki w sieć | Plik wybiera się przez `<input type="file">` w WebView. Bajty trafiają do komendy Tauri, bez ścieżek, bez nowych uprawnień systemu plików i bez wtyczek. CSP aplikacji (`default-src 'self'`) blokuje połączenia zewnętrzne. API Toggl **odrzucone**: wymagałoby tokenu (sekretu) i sieci, wbrew PTT-62. E-maila ani nazwy użytkownika z pliku nie zapisujemy. |
| Aktywny timer | Import jest dozwolony. Aktywny pomiar jest nietknięty; przedziały kolidujące z nim są odrzucane (§3.6). |
| Przywrócona kopia | `ensure_available` blokuje import po przywróceniu, do czasu restartu. |

---

## 7. UI

**Miejsce:** „Dane i ustawienia”, nowa karta **„Import z Toggl (CSV)”** obok „Kopia zapasowa”. To czynność jednorazowa, więc nie należy do głównego widoku timera.

**Przepływ:**

1. **Instrukcja.** W Toggl: Reports → Detailed → wybierz zakres → Export → CSV. Przed eksportem w profilu ustaw format daty `YYYY-MM-DD`, czas 24-godzinny, czas trwania „Improved” (dokładne nazwy opcji do potwierdzenia, O1) i wyłącz zaokrąglanie.
2. **Wybór pliku i strefy źródła**, domyślnie strefa raportowa, potem przycisk „Sprawdź plik”.
3. **Podgląd** (§5) z tabelą odrzuceń. Kolumny: Wiersz | Data i godzina (strefa źródła) | Klient / projekt | Opis (skrót) | Powód. Tabela ma filtr po powodzie, jest dostępna z klawiatury i ma nagłówki `scope`.
4. **Potwierdzenie:** „Rozumiem, że przed importem powstanie kopia bazy i że zaimportowane wpisy staną się zwykłymi wpisami” → „Importuj N wpisów”.
5. **Wynik:** „Zaimportowano 7 z 18 wierszy. 11 odrzucono — szczegóły poniżej. Kopia sprzed importu: `<ścieżka>`.” Gdy coś odrzucono, wynik ma styl ostrzeżenia, nie zwykłego sukcesu („bez fałszywego sukcesu”, AC4).

Przykładowe komunikaty o odrzuceniu:

- „Godzina nie istnieje w strefie Europe/Warsaw (zmiana czasu)”
- „Niejednoznaczna godzina przy zmianie czasu”
- „Nakłada się na inny wiersz pliku (wiersz 11)”
- „Nakłada się na istniejący wpis 05.11.2026 09:00–10:00”
- „Brak projektu — wpis do wyjaśnienia”
- „Brak klienta”
- „Wymaga mapowania: niejednoznaczna nazwa klienta”
- „Projekt w archiwum”
- „Czas zerowy”
- „Niezgodny czas trwania”
- „Pomiar bez zakończenia”
- „Powtórzony wiersz w pliku”

Przykładowe komunikaty o odrzuceniu całego pliku:

- „Plik nie jest w UTF-8”
- „Nieznany układ kolumn: brak Start date”
- „Plik zawiera wpisy wielu osób”
- „Plik przekracza 10 MB”

Raport odrzuceń w wersji 1 jest **tylko na ekranie** (O10). Zapis do pliku byłby kolejną ścieżką zapisu danych klientów; można go dodać później z ochroną formuł.

---

## 8. Testy

### 8.1 Oczekiwany wynik dla fixture (strefa źródła `Europe/Warsaw`, pusta baza)

| Wiersz | Wynik |
|---|---|
| 1, 2, 3, 4, 5, 6, 9 | **import**: 5400, 1800, 8130, 2700, 7200, 7200 i 5400 s; razem **37 830 s** |
| 7 | odrzucony: dwuznaczna godzina (DST jesień) |
| 8 | odrzucony: nieistniejąca godzina (DST wiosna) |
| 10, 11 | odrzucone: nakładanie w pliku (różni klienci, ta sama osoba) |
| 12 | odrzucony: czas zerowy |
| 13 | odrzucony: brak projektu |
| 14 | odrzucony: brak klienta (projekt „Projekt bez klienta” **nie** jest tworzony) |
| 15 | odrzucony: niezgodny czas trwania |
| 16, 17 | odrzucone: powtórzony wiersz |
| 18 | odrzucony: brak zakończenia |

**Raport po imporcie (Europe/Warsaw):**

| Dzień | Czas |
|---|---|
| 29.03 | 5400 s |
| 25.10 | 7200 s (doba 25-godzinna) |
| 02.11 | 7200 s |
| 03.11 | 8130 s |
| 04.11 | 2700 s |
| 16.11 | 1800 s |
| 17.11 | 5400 s |
| **Suma** | **37 830 s** |

Rozliczalne: 20 730 s, czyli 54,8%. Nowe obiekty: klienci 2, projekty 3, zadania 2.

### 8.2 Kryteria PTT-62 → testy

| AC | Test | Gdzie |
|---|---|---|
| AC1: N poprawnych → N wpisów, sumy co do sekundy | fixture → 7 wpisów, 37 830 s, sumy dzienne jak w §8.1. Ten sam wynik przez `reportByDay` (TECH-09) i KPI Summary. | Rust (CI `build`), node (lista „Check report calculations”), E2E |
| AC2: ponowny import = 0 nowych | drugi `prepare` i `apply` daje 0 / 7 / 11. Liczby i sumy bez zmian. Wariant: po zmianie nazwy projektu i po korekcie godzin jednego wpisu, wynik ten sam. | Rust, E2E |
| AC3: błąd w połowie → baza bez zmian, kopia istnieje | trigger `RAISE(FAIL)` na N-tym wierszu; `SQLITE_FULL` przez `PRAGMA max_page_count`; zmiana danych między podglądem a zapisem. Za każdym razem baza identyczna, kopia przechodzi preflight. | Rust; E2E (trigger przez testowe połączenie SQLite, jak w fazie `write-failure`) |
| AC4: nakładanie, DST, północ, brakujące pola | wiersze 5–18 z kodami powodów. Brak komunikatu sukcesu przy 0 importowanych. | Rust, E2E (zrzut tabeli odrzuceń) |

Testy dodatkowe:

- **Parser:** BOM / bez BOM, CRLF/LF, cytowanie, wielowierszowy opis, niedomknięty cudzysłów, UTF-16, NUL, limity, powtórzony nagłówek, wiele osób.
- **Mapowanie:** dokładne, podobne i niejednoznaczne nazwy, archiwum, D7 ze wspólną nazwą projektu.
- **Parzystość nakładania:** zamiatanie kontra `ensure_no_overlap`, w tym aktywny timer, wpis usunięty i wpis zerowy.
- **Migracja:** v14 → v15 z kopią, walidacja w preflight i przy odtwarzaniu, odmowa w starszym buildzie.
- **Wydajność:** 50 000 wierszy na 10 000 istniejących; wynik zapisywany jako pomiar, nie jako SLO.
- **Eksport:** po imporcie CSV escapuje `=SUMA`.

### 8.3 Co w CI, co na Windows 11

- **CI (Windows Server, dokładny SHA, dwa zielone przebiegi):** `cargo test` (parser, walidacja, transakcja, migracja), node z listy workflow (nowy plik testu dopisany do listy) oraz E2E `windows-application`.
  - Nowa faza `toggl-import` na profilu `pl.tracker.personal.testonly`: plik podawany przez CDP `DOM.setFileInputFiles`.
  - Zrzuty `toggl-import` 1280×720, 1920×1080 i 125%.
  - Opcjonalnie rozszerzenie fazy T27 (VHD) o import na pełnym dysku.
  - Rust nie działa lokalnie (os error 4551, Smart App Control): weryfikacja **wyłącznie w CI**. Ochrony nie wyłączamy.
- **Windows 11 x64 (odbiór ręczny, właściciel, poza repo):** prawdziwy eksport właściciela, na jego komputerze. Sprawdzamy:
  - zgodność sum Toggl i TrackerMaster dla tego samego zakresu co do sekundy, w tym miesiące z DST;
  - czytnik Narrator na podglądzie i tabeli odrzuceń;
  - DPI 125/150%;
  - instalację MSIX (`app_data_dir`).

  Prawdziwy plik ani jego zrzuty z danymi nie trafiają do repo, CI ani Notion. Do Notion trafia tylko wynik PASS/FAIL i liczby.

---

## 9. Podział na PR-y, ryzyka, szacunek, decyzje

### 9.1 PR-y (DEV-40)

| PR | Zakres | Rozmiar |
|---|---|---|
| **A** `feat/dev40-toggl-parser-…` | moduł Rust `toggl_import.rs`, czysty i bez bazy: dekodowanie, nagłówki, rekordy, rozstrzyganie strefy i DST, kody odrzuceń, odcisk; testy na fixture. Rekomendacja: crate `csv` (dojrzały, RFC 4180) zamiast własnego parsera; do decyzji recenzenta. | M |
| **B** `feat/dev40-import-schema-v15-…` | migracja `import_batches` / `imported_entries` z kopią, triggery, walidacja w `initialise`, preflight i restore | S–M |
| **C** `feat/dev40-import-commands-…` | `prepare_toggl_import` / `apply_toggl_import`, mapowanie, nakładanie przez zamiatanie, kopia, transakcja, ponowna weryfikacja planu; testy AC1–AC4 w Rust | M |
| **D** `feat/dev40-import-ui-e2e-…` | karta UI, podgląd, tabela odrzuceń, faza E2E `toggl-import`, zrzuty | M |

Kolejność: A → B → C → D. B może iść równolegle z A. Każdy PR wymaga własnego CI, recenzji i zgody na scalenie.

**Szacunek:** łącznie ok. 4–6 dni pracy agenta, z cyklami CI i recenzją; najwięcej zajmą C i D. Do tego odbiór Windows 11 przez właściciela. Szacunek orientacyjny, nie zobowiązanie.

### 9.2 Ryzyka

1. **Niepotwierdzony format eksportu** (§1.2). Ograniczenie: parser po nagłówkach, odrzucanie nieznanego układu, warunek O1 przed scaleniem PR A.
2. **Formaty daty i czasu trwania zależne od profilu.** Wymagamy ISO i HH:MM:SS, inne odrzucamy z instrukcją.
3. **Nieznana strefa w pliku.** Jawny wybór strefy, odrzucanie dwuznaczności DST. Błędny wybór strefy przesunie wszystkie wpisy. Ograniczenie: podgląd pokazuje zakres dat i godziny pierwszych wpisów do sprawdzenia.
4. **Zaokrąglanie lub sekundy w Toggl.** Przy zerowej tolerancji duża liczba odrzuceń „niezgodny czas trwania” jest możliwa. Pokaże to odbiór na prawdziwym pliku; ewentualna zmiana tolerancji wymaga decyzji, nie cichej korekty.
5. **Wydajność i rozmiar kopii** przy dużej bazie (brak retencji kopii).
6. **Kolizje z historycznymi nakładaniami w bazie.** Są odrzucane poprawnie, ale mogą zaskoczyć; komunikat wskazuje kolidujący wpis.
7. **Dane klientów w nieszyfrowanych kopiach** (granica D7, bez zmian).
8. **Weryfikacja Rust wyłącznie w CI**, więc dłuższe cykle.

### 9.3 Otwarte decyzje dla właściciela (z rekomendacją)

| # | Pytanie | Rekomendacja |
|---|---|---|
| O1 | Dostarczenie nagłówka prawdziwego eksportu i ustawień profilu | **Tak, przed scaleniem PR A.** Sam nagłówek, bez danych. |
| O2 | Projekt bez klienta w Toggl | **A: odrzucić z powodem.** B (ręczne przypisanie klienta w podglądzie) ewentualnie w kolejnej wersji. |
| O3 | Dopasowany obiekt w archiwum | **A: odrzucić z powodem**, użytkownik świadomie przywraca i importuje ponownie. B: import do archiwum. |
| O4 | Tagi | **A: pominąć w opisie/raportach, policzyć w podglądzie, zachować surowo w metadanych importu.** B: dopisać do opisu. |
| O5 | Limity pliku | **10 MB i 50 000 wierszy.** |
| O6 | Wiersze poprawne przy odrzuconych | **Import poprawnych wierszy, odrzucone w raporcie** (zgodnie z PTT-62), atomowo w jednej transakcji. Alternatywa: wszystko albo nic. |
| O7 | Format daty | **Tylko `YYYY-MM-DD` + 24 h**, bez zgadywania innych formatów. |
| O8 | Tolerancja `koniec − start` vs `Duration` | **0 s.** Weryfikacja na prawdziwym pliku (ryzyko 4). |
| O9 | Ponowny import usuniętego wcześniej wpisu | **Nie przywracać**; status „wcześniej zaimportowany (usunięty)”. |
| O10 | Raport odrzuceń do pliku | **Nie w wersji 1**, tylko na ekranie. |
| O11 | Domyślna rozliczalność nowych projektów | **Nie**: rozliczalność tylko z kolumny `Billable` per wpis. |

Decyzje D5, D7, D10 i D12 stosujemy bez zmian. Żadna rekomendacja ich nie modyfikuje.

---

## 10. Źródła (odczyt 24.11.2026)

Oficjalna dokumentacja Toggl:

- **[S1]** Detailed report — https://support.toggl.com/en-us/article/detailed-report-k9bzy2/ (stary adres `…/detailed-report-enasur` pokazuje tę samą treść).
- **[S2]** Exporting data — https://support.toggl.com/en-us/article/exporting-data-z53uki/
- **[S3]** Toggl Track CSV Import Guide — https://support.toggl.com/en-us/article/toggl-track-csv-import-guide-yx49tl/ (tabela kolumn jest obrazem, nieczytelnym automatycznie).
- **[S4]** Editing and uploading a CSV file — https://support.toggl.com/en-us/article/editing-and-uploading-a-csv-file-bk155h/
- **[S5]** Reports API v3, Detailed reports — https://engineering.toggl.com/docs/track/reports/detailed_reports/ oraz exports — https://engineering.toggl.com/docs/track/reports/exports/
- **[S6]** Track API v9, Time entries — https://engineering.toggl.com/docs/track/api/time_entries/
- **[S7]** API & Webhook limits — https://support.toggl.com/en-us/article/api-webhook-limits-85auc8/

Nieczynne adresy (HTTP 404): `support.toggl.com/en-us/article/detailed-report`, `…/exporting-reports`, `…/importing-time-entries`.

Notion (tylko do odczytu): PTT-62, TECH-13, D7, D10, D12 (w tym D12.1 północ, strefa raportowa, billable B, opis opcjonalny B, nazwy „jak Toggl” B, archiwizacja), PTT-28 (mapowanie). Kod: `src-tauri/src/main.rs` (`ensure_no_overlap`, `parse_manual_range`, `valid_name`, `valid_description`, `initialise_with_backup`), `optional_task_migration.rs` (`insert_manual_in`, `target_billing`), `storage_safety.rs` (`create_backup`), `src/reportCsv.ts` (ochrona formuł), `src/App.tsx` (karta kopii zapasowej), `tests/windows-application.mjs` (faza T27).
