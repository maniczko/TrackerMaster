# TECH-14 — Wyszukiwanie w historii wpisów: analiza i pomiar

| | |
|---|---|
| Karty | [TECH-14](https://app.notion.com/p/422e1de1f67a819683f9f8607e31a29b) (analiza), [PTT-63](https://app.notion.com/p/422e1de1f67a81f190f1e077d98b3f26) (wymaganie, V1.1, Should) |
| Baza | `main` @ `de9091e` (#65), schemat SQLite v14 (`LATEST_SCHEMA_VERSION`). Pomiary wykonano na `f2a3386`; moduły raportu (`reportTime`, `reportView`, `reportDayModel`, `sleepTime`, `reportClientFilter`, `reportScope`, `useAllClientsReport`) i `main.rs` są w `de9091e` identyczne |
| Zakres | analiza, pomiar i rekomendacja. **Bez zmian w kodzie aplikacji**: skrypty pomiarowe są w `docs/tech14/` i nie trafiają do bundla (Vite buduje tylko z `src/index.html`) |
| Dane | wyłącznie syntetyczne, generowane deterministycznie (stałe ziarno, stałe „teraz” 24.11.2026 12:00 Warszawa) |

## 0. Wnioski w skrócie

1. **Rekomendacja: wyszukiwanie w JS w oknie aplikacji (wariant J), na danych, które okno już ma.** Wspólny odczyt raportu (`useAllClientsReport` → `get_report_data`, wszyscy klienci) zawiera już **wszystkie** nieusunięte wpisy z opisami. Historia (snapshot) ma tylko ostatnie 500. Wyszukiwanie nie wymaga nowej komendy, migracji ani zmian w Rust, a fraza nie opuszcza procesu WebView.
2. **Filtr tekstu jest szybki:** 10 000 wpisów: 0,5–2,5 ms, 50 000: 3–18 ms (mediana; p95 ≤ 38 ms; Node i Edge, tabele w §3). Ten etap AC3 (< 200 ms) spełnia z dużym zapasem. Indeks znormalizowanego tekstu budujemy raz na odczyt danych: 24–26 ms (10k), 221–248 ms (50k).
3. **Wąskim gardłem jest suma wyniku, nie wyszukiwanie.** Dziś jedyna funkcja licząca sumę zgodną z Raportem to `makeReportView`. Na wynikach kosztuje od ok. 0,2 ms na wpis, gdy pasuje wszystko, do ok. 1,4 ms na wpis przy wyniku rozsianym po latach (10 000 dopasowań ≈ 2,1 s, 50 000 ≈ 10,6 s; w Edge podobnie). Przyczyna: polyfill Temporal (`getTimeZoneTransition`, arytmetyka JSBI) w `calendarPieces`, którego pamięć granic dnia żyje tylko przez jedno wywołanie (§3.4).
4. **Proponowany sposób liczenia sumy (J3), zgodny z Raportem co do sekundy:** raz na odczyt danych i zakres dat liczymy jeden `makeReportView` na wszystkich wpisach. Przy każdym znaku sumujemy gotowe wkłady (`contributions`) pasujących wpisów. Suma Raportu jest prostą sumą wkładów wpisów, więc wynik jest identyczny. Skrypt sprawdza równość sekund i czasu oczekującego dla każdego zapytania przy 10 000 i 50 000 wpisów. Sumowanie trwa ≤ 0,7 ms przy 10 000 i ≤ 4 ms przy 50 000 wpisów (p95, Node i Edge).
   - Koszt przenosi się do raportu bazowego: w obecnym kodzie cała historia 10 000 wpisów to 1,0–2,2 s (zależnie od wywołania, §3.4), a 30 dni ok. 0,1 s. Dlatego **warunkiem wstępnym jest trwała pamięć granic dnia w `reportTime`**. Prototyp zmiany (5 linii, poza kodem aplikacji) daje wyniki identyczne z obecnym kodem i skraca raport bazowy całej historii do ~80 ms przy 10 000 i ~360 ms przy 50 000 wpisów (ciepła pamięć).
5. **FTS5 `unicode61 remove_diacritics 2` nie spełnia AC1:** „zolc” nie znajduje „żółć”, bo litera „ł” nie ma rozkładu Unicode i tokenizer jej nie upraszcza. Sprawdzone na SQLite 3.53.4 (`node:sqlite`). Aplikacja ma SQLite 3.46.0 z FTS5. Lokalnie nie sprawdziłem tego na 3.46.0 (cargo zablokowane, os error 4551), ale tokenizer upraszcza znaki na podstawie rozkładu Unicode, którego „ł” nie ma. **Jeśli kiedyś wybierzemy SQLite, potwierdzi to test Rust w CI.** SQLite `LIKE` nie upraszcza wielkości liter poza ASCII („Ż” ≠ „ż”). Wariant SQLite wymaga własnej normalizacji, migracji i utrzymywania kopii tekstu, a i tak nie rozwiązuje kosztu sumy.

## 1. Stan obecny (`main` @ `de9091e`)

| Element | Co robi dziś | Znaczenie dla wyszukiwania |
|---|---|---|
| Historia (`App.tsx`, karta „Historia pomiarów”) | Wpisy z `get_snapshot`: `ORDER BY id DESC LIMIT 500`. Grupowanie dni przez `historyDays` (`reportDayModel.ts`) na odczycie raportu. | Wyszukiwanie w samym snapshocie widziałoby tylko 500 wpisów, czyli za mało. |
| Wspólny odczyt raportu (`useAllClientsReport`) | `get_report_data` dla wszystkich klientów: wszystkie zakończone, nieusunięte wpisy (`project_id`, `task_id`, `billable`, `description`, okresy uśpienia), aktywny pomiar i strefa raportu. Odświeżanie: 60 s, fokus, `reportRevision` i `snapshotSignature`. | **Pełne źródło danych dla wyszukiwania**, już w pamięci okna. |
| Nazwy klientów, projektów i zadań | Katalog ze snapshotu (`clients`, `projects`, `tasks`, także zarchiwizowane). | Dopasowanie po nazwach bez denormalizacji wpisów. |
| Opisy | `entry_descriptions` (≤ 2000 znaków, bez znaków sterujących), historia zmian w `description_revisions`. | Pole do przeszukania. |
| Suma zgodna z Raportem | `makeReportView` → `reportByDay` (segmentacja TECH-09/D12, uśpienie, oczekujące, projekcja aktywnego pomiaru). | Jedyne dopuszczalne źródło sum (AC2). |
| Logi | UI nie woła `console.*`, Rust nie loguje argumentów komend (brak `println!`/`log`). | Fraza nie trafi do logów, jeśli tego nie dodamy. |
| `localStorage` | Widok (`trackermaster.view.v1`), kalendarz (`trackermaster.calendar.v1`), filtry raportu, `widget-on-top`. | Fraza wyszukiwania **nie** może dołączyć do tej listy (§6). |

## 2. Zakres wyszukiwania

### 2.1 Co jest przeszukiwane

- **Pola:** opis wpisu, nazwa klienta, projektu i zadania (także zarchiwizowanych, bo ich wpisy są w Raporcie).
- **Wpisy:** zakończone i nieusunięte, czyli dokładnie te, które zwraca `get_report_data`. Aktywny pomiar jest w wyniku tylko wtedy, gdy Raport go liczy: rozstrzygnięty (`!unresolved`), z projekcją końca i ze statusem „w toku”. Pomiar „do weryfikacji” lub niepewny po uśpieniu nie jest liczony, tak jak w Raporcie i `totalsBaseData`.
- **Usunięte wpisy** (`entry_deletions`) nie są wyszukiwane. Mają osobny widok „Usunięte”.

### 2.2 Dopasowanie

- **Zwykły tekst, bez operatorów** w V1.1. Fraza jest dzielona na człony po białych znakach. Wpis pasuje, gdy **każdy** człon jest podciągiem jego tekstu (AND), np. „studio lak” → klient „Studio Łąka”. Cudzysłowy, `-` i `OR` są otwartą decyzją D-1 (§8.4).
- **Podciąg, nie początek słowa:** „olc” znajdzie „żółć”, a „zolc” znajdzie „Zażółć”. Jest to zachowanie przewidywalne dla użytkownika i zgodne z polem wyszukiwania projektów (UIQ-05).
- Pusta fraza (po normalizacji) wyłącza filtr tekstu. Limit długości frazy: 200 znaków (propozycja).

### 2.3 Normalizacja („zolc” → „żółć”)

```js
foldText = text => text.toLocaleLowerCase('pl').normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l');
```

| Wejście | Po `toLocaleLowerCase` + NFD + usunięciu znaków łączących | Po `ł → l` |
|---|---|---|
| `Żółć` | `zołc` | `zolc` |
| `Łódź` | `łodz` | `lodz` |
| `ŻÓŁTY` | `zołty` | `zolty` |
| `gęślą jaźń` | `gesla jazn` | `gesla jazn` |

- **Krok `ł → l` jest konieczny.** NFD nie rozkłada „ł” (U+0142), więc samo usunięcie znaków diakrytycznych zostawia „zołc” (sprawdzone w Node 24). Ten sam brak ma FTS5 (§0, pkt 5).
- Ta sama funkcja jest stosowana do tekstu wpisu i do frazy, więc wpisy w NFC i NFD dają ten sam wynik.
- Poza zakresem V1.1: inne litery bez rozkładu (`ø`, `đ`, `ß`). Lista jest rozszerzalna w jednym miejscu.

### 2.4 Filtr zakresu dat

- Zakres `od`–`do` w **dniach lokalnych strefy raportu**, z gotowymi okresami z `reportPresetRange` (Dziś, Ten tydzień, Ten miesiąc, …) i zakresem własnym.
- Wpis pasuje, jeśli którakolwiek jego część dnia (TECH-09) leży w zakresie. Suma obejmuje tylko części w zakresie, tak jak Raport. Wpis 23:30–00:45 przy zakresie „tylko drugi dzień” wnosi 45 min.
- W filtrze tekstu stosujemy zgrubny margines ±1 doba UTC. Dokładne przycięcie do dni lokalnych robi funkcja Raportu, więc zgrubny filtr nie wpływa na sumę.

### 2.5 Gdzie wykonywać: JS w UI czy SQLite

| Kryterium | J: JS w oknie (rekomendacja) | S2: `LIKE` na kolumnie znormalizowanej | S3/S4: FTS5 `unicode61` | S5: FTS5 `trigram` |
|---|---|---|---|---|
| AC1 („zolc” → „żółć”, podciąg) | tak | tak (normalizacja w Rust przy zapisie) | **nie** (S3: „ł”; S4: tylko początek tokenu, „Zażółć” pominięte) | tak, ale człony < 3 znaków nie działają |
| Migracja schematu | brak | nowa tabela i wypełnienie przy migracji, schemat v15 | tabela wirtualna i tabele cieni FTS, v15 | jak S3, największy indeks |
| Utrzymanie przy zapisie | brak | każda zmiana opisu, nazwy klienta, projektu lub zadania aktualizuje kopie tekstu (zmiana nazwy klienta = wszystkie jego wpisy) | jak S2 plus triggery FTS | jak S3 |
| Rozmiar bazy (§3.3) | 0 | +0,71 MB / +3,53 MB (10k / 50k) | +1,1 MB / +5,4–5,6 MB | +2,58 MB / +12,8 MB |
| Walidacja bazy (`storage_safety`, preflight, kopie) | bez zmian | nowe obiekty do walidacji | tabele cieni FTS, kontrola integralności FTS | jak S3 |
| Suma zgodna z Raportem | J3 (§4) | i tak w JS, bo segmentacja i uśpienie są w TS | jw. | jw. |
| Prywatność | fraza zostaje w WebView | fraza przechodzi przez IPC do Rust | jw. | jw. |
| Starsze buildy | bez wpływu | migracja jednokierunkowa, starszy build odmówi bazy v15 | jw. | jw. |

SQLite daje szybsze dopasowanie przy bardzo dużych bazach, ale tylko dopasowanie: sumę i tak trzeba policzyć w TS. Przy obecnej skali (pomiar do 50 000 wpisów) filtr JS mieści się w kilkunastu ms, więc koszty i ryzyka wariantu SQLite nie są uzasadnione. **Rozważyć ponownie przy > 100 000 wpisów** (próg do potwierdzenia pomiarem).

## 3. Pomiar

### 3.1 Środowisko i metoda

| | |
|---|---|
| Komputer | stacja właściciela, laptop: Intel Core i5-1235U (10 rdzeni / 12 wątków), 32 GB RAM, Windows 11 Pro 10.0.26300 (x64). Planu zasilania nie odczytano (wymaga uprawnień administratora); pomiary na zasilaniu sieciowym, bez innego obciążenia. |
| Node | v24.20.0 (V8), natywne usuwanie typów TS. Importuje **niezmienione** moduły `src/` (`reportView.ts`, `reportDayModel.ts`, `sleepTime.ts`). |
| Przeglądarka | Microsoft Edge 158.0.4370.33, headless (Chromium, ta sama rodzina silnika co WebView2). Kod spakowany przez esbuild 0.28.2 (zależność Vite). |
| SQLite | `node:sqlite` 3.53.4. Aplikacja: `rusqlite` 0.32 / `libsqlite3-sys` 0.30.1 z SQLite **3.46.0** (bundled, `-DSQLITE_ENABLE_FTS5`). |
| Powtórzenia | 3 przebiegi rozgrzewki + 15 pomiarów (dla wolnych przypadków 1 + 3–5). Podajemy **medianę / p95 w ms**. Każde zapytanie SQLite porównano z wynikiem wariantu JS (✓ / ✗). |
| Dane | 10 000 i 50 000 wpisów, ~8 dziennie (10k ≈ 4,1 roku, 1493 dni z wpisami; 50k ≈ 20,4 roku, 7425 dni). 8 klientów, 40 projektów, 200 zadań (polskie nazwy z diakrytykami). Ok. 2% wpisów przez północ, 1% z okresem uśpienia (`pending` / `included` / `excluded` / `auto_included`), 25% bez opisu, 40% bez zadania. Opisy 2–9 słów, rzadkie słowa „żółć”, „Łódź”, „ŻÓŁTY”, „Zażółć”. Znaczniki czasu w formacie zapisu aplikacji (UTC z milisekundami, `now()` w `main.rs`). |

Uruchomienie (wymaga `npm ci`):

```powershell
node docs/tech14/bench-node.mjs
node docs/tech14/bench-cache-proto.mjs
node docs/tech14/run-edge.mjs
```

**Uwaga do pierwszego przebiegu:** pierwsza wersja generatora zapisywała czas bez milisekund (`…:00Z`). Raport parsuje taki format wolniejszą ścieżką Temporal, więc wynik był niereprezentatywny. Po poprawce wszystkie tabele poniżej pochodzą z przebiegu na formacie aplikacji.

**Czego nie zmierzono:**
- przesłania `get_report_data` przez IPC Tauri do WebView2 (mierzymy `JSON.parse` tego samego ładunku);
- renderowania wierszy w React/DOM;
- pomiarów w samej aplikacji: lokalnie zablokowane (os error 4551), do zrobienia w E2E DEV-41.

### 3.2 Warianty JS

- **J0:** normalizacja wszystkich pól przy każdym zapytaniu (bez indeksu).
- **J1:** filtr na indeksie znormalizowanego tekstu, budowanym raz na odczyt danych.
- **J3:** suma wyniku z wkładów jednego raportu bazowego (§4.2).
- **„Suma: makeReportView na wynikach”:** obecny kod uruchomiony na pasujących wpisach.
- **„Grupowanie dni”:** obecny `historyDays` na pasujących wpisach.

#### Node: 10 000 wpisów

Dane: 570 wpisów przez północ (UTC), 101 z okresami uśpienia. Ładunek get_report_data (JSON): 2.02 MB, JSON.parse: 4.26 / 9.3 ms. Budowa indeksu JS: 26.46 / 29.34 ms (639049 znaków).
Raport bazowy dla J3 (jeden makeReportView na wszystkich wpisach, raz na odczyt danych i zakres): cała historia 1068.58 / 2000.6 ms; ostatnie 30 dni 96.73 / 106.1 ms.

| Zapytanie | Wyniki | J0 bez indeksu | J1 filtr | J3 suma z wkładów | Suma: makeReportView na wynikach (obecny kod) | Grupowanie dni (historyDays) | AC2 |
|---|---:|---:|---:|---:|---:|---:|---|
| `zolc` | 186 | 25.82 / 27.02 | 0.81 / 1.07 | 0.01 / 0.04 | 266.44 / 272.87 | 337.48 / 356.75 | równe (s i oczekujące) |
| `lodz` | 112 | 45.26 / 48.17 | 1.31 / 1.45 | 0.01 / 0.01 | 159.12 / 168.4 | 200.21 / 212.98 | równe (s i oczekujące) |
| `spotkanie` | 866 | 46.16 / 48.31 | 1.11 / 1.71 | 0.04 / 0.04 | 960.35 / 1018.71 | 1238.6 / 1278.66 | równe (s i oczekujące) |
| `studio lak` | 1266 | 45.02 / 47.1 | 1.23 / 1.43 | 0.05 / 0.1 | 1287.38 / 1396.3 | 1681.77 / 1708.68 | równe (s i oczekujące) |
| `a` | 10000 | 45.65 / 48.37 | 0.47 / 0.5 | 0.25 / 0.27 | 2138.06 / 2257.42 | 4535.78 / 4608.44 | równe (s i oczekujące) |
| `xqzv` | 0 | 44.78 / 46.83 | 0.56 / 0.58 | 0 / 0 | 0.06 / 0.14 | 0 / 0.01 | równe (s i oczekujące) |
| `spotkanie` (30 dni) | 11 | — | 2.49 / 2.7 | 0 / 0 | 17.6 / 20.95 | 22.1 / 30.9 | równe (s i oczekujące) |

#### Node: 50 000 wpisów

Dane: 2834 wpisów przez północ (UTC), 503 z okresami uśpienia. Ładunek get_report_data (JSON): 10.12 MB, JSON.parse: 35.21 / 36.98 ms. Budowa indeksu JS: 221.07 / 224.65 ms (3182058 znaków).
Raport bazowy dla J3 (jeden makeReportView na wszystkich wpisach, raz na odczyt danych i zakres): cała historia 10794.66 / 10864.47 ms; ostatnie 30 dni 319.15 / 319.21 ms.

| Zapytanie | Wyniki | J0 bez indeksu | J1 filtr | J3 suma z wkładów | Suma: makeReportView na wynikach (obecny kod) | Grupowanie dni (historyDays) | AC2 |
|---|---:|---:|---:|---:|---:|---:|---|
| `zolc` | 1000 | 228.69 / 246.73 | 6.66 / 11.87 | 0.04 / 0.05 | 1363.69 / 1390.78 | 1736.35 / 1774.82 | równe (s i oczekujące) |
| `lodz` | 543 | 238.63 / 264.64 | 6.78 / 8.22 | 0.02 / 0.02 | 770.39 / 808.44 | 960.18 / 1067.23 | równe (s i oczekujące) |
| `spotkanie` | 4226 | 227.28 / 245.26 | 5.55 / 5.74 | 0.22 / 0.23 | 4764.91 / 4905.46 | 6334.49 / 6446.11 | równe (s i oczekujące) |
| `studio lak` | 6286 | 230.11 / 240.03 | 6.23 / 6.68 | 0.37 / 0.49 | 6335.17 / 6507.61 | 8408.22 / 8568.93 | równe (s i oczekujące) |
| `a` | 50000 | 225.22 / 232.49 | 2.99 / 4.08 | 2.07 / 2.25 | 10585.33 / 10736.07 | 22541.9 / 23108.66 | równe (s i oczekujące) |
| `xqzv` | 0 | 223.01 / 247.85 | 3.03 / 3.12 | 0 / 0 | 0.05 / 0.09 | 0 / 0.01 | równe (s i oczekujące) |
| `spotkanie` (30 dni) | 11 | — | 12.47 / 14.41 | 0 / 0 | 17.41 / 26.2 | 22.36 / 27.87 | równe (s i oczekujące) |

Edge: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0`. Tryb lekki: bez J0 i `historyDays`, a „Suma: makeReportView” tylko dla wyników ≤ 1500 wpisów (dla większych kontrola AC2 liczy ją raz, bez pomiaru).

#### Edge: 10 000 wpisów

Dane: 570 wpisów przez północ (UTC), 101 z okresami uśpienia. Ładunek get_report_data (JSON): 2.02 MB, JSON.parse: 3.4 / 5.8 ms. Budowa indeksu JS: 23.9 / 26 ms (639049 znaków).
Raport bazowy dla J3 (jeden makeReportView na wszystkich wpisach, raz na odczyt danych i zakres): cała historia 1334.4 / 1334.4 ms; ostatnie 30 dni 106.2 / 106.2 ms.

| Zapytanie | Wyniki | J0 bez indeksu | J1 filtr | J3 suma z wkładów | Suma: makeReportView na wynikach (obecny kod) | Grupowanie dni (historyDays) | AC2 |
|---|---:|---:|---:|---:|---:|---:|---|
| `zolc` | 186 | — | 1.5 / 2.4 | 0 / 0.3 | 158.2 / 160.5 | — | równe (s i oczekujące) |
| `lodz` | 112 | — | 0.9 / 1.3 | 0 / 0 | 88.2 / 90.9 | — | równe (s i oczekujące) |
| `spotkanie` | 866 | — | 0.8 / 1.1 | 0 / 0.1 | 1051.6 / 1071.2 | — | równe (s i oczekujące) |
| `studio lak` | 1266 | — | 1.4 / 1.6 | 0 / 0.1 | 1420 / 1423.8 | — | równe (s i oczekujące) |
| `a` | 10000 | — | 0.6 / 1 | 0.3 / 0.7 | — | — | równe (s i oczekujące) |
| `xqzv` | 0 | — | 0.7 / 0.8 | 0 / 0.1 | 0.1 / 0.1 | — | równe (s i oczekujące) |
| `spotkanie` (30 dni) | 11 | — | 1.9 / 2.1 | 0 / 0.1 | 19.9 / 21.5 | — | równe (s i oczekujące) |

#### Edge: 50 000 wpisów

Dane: 2834 wpisów przez północ (UTC), 503 z okresami uśpienia. Ładunek get_report_data (JSON): 10.12 MB, JSON.parse: 33.2 / 33.7 ms. Budowa indeksu JS: 247.6 / 274.9 ms (3182058 znaków).
Raport bazowy dla J3 (jeden makeReportView na wszystkich wpisach, raz na odczyt danych i zakres): cała historia 11756.6 / 11756.6 ms; ostatnie 30 dni 653 / 653 ms.

| Zapytanie | Wyniki | J0 bez indeksu | J1 filtr | J3 suma z wkładów | Suma: makeReportView na wynikach (obecny kod) | Grupowanie dni (historyDays) | AC2 |
|---|---:|---:|---:|---:|---:|---:|---|
| `zolc` | 1000 | — | 7.7 / 9.4 | 0.1 / 0.1 | 1613.3 / 1786.4 | — | równe (s i oczekujące) |
| `lodz` | 543 | — | 7.7 / 8.1 | 0 / 0.1 | 1446 / 1571.3 | — | równe (s i oczekujące) |
| `spotkanie` | 4226 | — | 10.7 / 12.3 | 0.3 / 0.5 | — | — | równe (s i oczekujące) |
| `studio lak` | 6286 | — | 13.9 / 14.9 | 0.7 / 1.3 | — | — | równe (s i oczekujące) |
| `a` | 50000 | — | 5.7 / 38.4 | 2.9 / 3.7 | — | — | równe (s i oczekujące) |
| `xqzv` | 0 | — | 7.2 / 8.1 | 0 / 0 | 0.1 / 0.1 | — | równe (s i oczekujące) |
| `spotkanie` (30 dni) | 11 | — | 18 / 19.5 | 0 / 0 | 39.8 / 40.8 | — | równe (s i oczekujące) |

### 3.3 Warianty SQLite (Node, `node:sqlite` 3.53.4)

Każdy wariant mierzono na bazie z tabelami aplikacji (kolumny i ograniczenia jak w schemacie v14) i tylko z własnym indeksem. „Budowa” to czas wypełnienia indeksu, czyli przybliżenie kosztu migracji. „Przyrost bazy” zmierzono po `VACUUM`. Komórka: mediana / p95 ms; wyniki/oczekiwane; ✓ = te same wpisy co J.

#### 10 000 wpisów (baza bez indeksu wyszukiwania: 1.09 MB)

| Wariant SQLite | Budowa (ms) | Przyrost bazy | `zolc` | `lodz` | `spotkanie` | `studio lak` | `a` | `xqzv` |
|---|---:|---:|---|---|---|---|---|---|
| S1 LIKE (surowe kolumny) | 0 | 0 | 7.91 / 10.54 ms; 0/186 ✗ | 7.82 / 8.88 ms; 0/112 ✗ | 8.33 / 8.81 ms; 866/866 ✓ | 8.36 / 9.02 ms; 0/1266 ✗ | 12.08 / 12.75 ms; 10000/10000 ✓ | 7.35 / 7.99 ms; 0/0 ✓ |
| S2 LIKE (kolumna znormalizowana) | 74.73 | +0.71 MB | 3.14 / 3.22 ms; 186/186 ✓ | 3.15 / 3.3 ms; 112/112 ✓ | 3.32 / 3.4 ms; 866/866 ✓ | 3.73 / 3.85 ms; 1266/1266 ✓ | 6.16 / 6.97 ms; 10000/10000 ✓ | 2.39 / 3.35 ms; 0/0 ✓ |
| S3 FTS5 unicode61 remove_diacritics 2 | 38.45 | +1.14 MB | 0.03 / 0.03 ms; 0/186 ✗ | 0.02 / 0.02 ms; 0/112 ✗ | 0.72 / 1 ms; 866/866 ✓ | 0.05 / 0.14 ms; 0/1266 ✗ | 3.32 / 3.6 ms; 4496/10000 ✗ | 0.02 / 0.02 ms; 0/0 ✓ |
| S4 FTS5 na tekście znormalizowanym | 93.2 | +1.09 MB | 0.1 / 0.12 ms; 96/186 ✗ | 0.12 / 0.15 ms; 112/112 ✓ | 0.79 / 0.93 ms; 866/866 ✓ | 1.17 / 1.55 ms; 1266/1266 ✓ | 3.52 / 4.38 ms; 4496/10000 ✗ | 0.02 / 0.02 ms; 0/0 ✓ |
| S5 FTS5 trigram (tekst znormalizowany) | 138.13 | +2.58 MB | 0.23 / 0.34 ms; 186/186 ✓ | 0.12 / 0.13 ms; 112/112 ✓ | 1.21 / 1.33 ms; 866/866 ✓ | 1.15 / 1.27 ms; 1266/1266 ✓ | nie obsługuje (< 3 znaki) | 0.02 / 0.06 ms; 0/0 ✓ |

#### 50 000 wpisów (baza bez indeksu wyszukiwania: 5.34 MB)

| Wariant SQLite | Budowa (ms) | Przyrost bazy | `zolc` | `lodz` | `spotkanie` | `studio lak` | `a` | `xqzv` |
|---|---:|---:|---|---|---|---|---|---|
| S1 LIKE (surowe kolumny) | 0 | 0 | 47.75 / 53.09 ms; 0/1000 ✗ | 47.49 / 52.09 ms; 0/543 ✗ | 52.06 / 61.49 ms; 4226/4226 ✓ | 50.13 / 55.38 ms; 0/6286 ✗ | 72.05 / 160.86 ms; 50000/50000 ✓ | 46.3 / 48.5 ms; 0/0 ✓ |
| S2 LIKE (kolumna znormalizowana) | 360.61 | +3.53 MB | 26.53 / 29.05 ms; 1000/1000 ✓ | 25.61 / 27.47 ms; 543/543 ✓ | 26.71 / 28.92 ms; 4226/4226 ✓ | 32.57 / 37.96 ms; 6286/6286 ✓ | 42.47 / 49.59 ms; 50000/50000 ✓ | 23.22 / 24.37 ms; 0/0 ✓ |
| S3 FTS5 unicode61 remove_diacritics 2 | 237.5 | +5.64 MB | 0.02 / 0.04 ms; 0/1000 ✗ | 0.02 / 0.02 ms; 0/543 ✗ | 8.06 / 8.49 ms; 4226/4226 ✓ | 0.18 / 0.21 ms; 0/6286 ✗ | 22.32 / 27.45 ms; 22131/50000 ✗ | 0.02 / 0.02 ms; 0/0 ✓ |
| S4 FTS5 na tekście znormalizowanym | 466.65 | +5.42 MB | 0.42 / 0.48 ms; 463/1000 ✗ | 0.49 / 0.53 ms; 543/543 ✓ | 8.08 / 8.85 ms; 4226/4226 ✓ | 10.17 / 15.31 ms; 6286/6286 ✓ | 22.26 / 37.24 ms; 22131/50000 ✗ | 0.02 / 0.02 ms; 0/0 ✓ |
| S5 FTS5 trigram (tekst znormalizowany) | 904.18 | +12.80 MB | 4.5 / 4.76 ms; 1000/1000 ✓ | 0.54 / 0.58 ms; 543/543 ✓ | 11.56 / 11.71 ms; 4226/4226 ✓ | 11.19 / 16 ms; 6286/6286 ✓ | nie obsługuje (< 3 znaki) | 0.02 / 0.02 ms; 0/0 ✓ |

Odczyt wyników:
- **S1 `LIKE`** na surowych kolumnach nie znajduje „zolc”, „lodz” ani „studio lak” (wielkość liter tylko ASCII, bez upraszczania znaków).
- **S3 FTS5** z `remove_diacritics 2` nie znajduje „zolc” ani „lodz” (litera „ł”). Dla „a” dopasowuje tylko tokeny zaczynające się od „a”.
- **S4** (FTS5 na tekście znormalizowanym przez aplikację) naprawia „ł”, ale pomija dopasowania w środku słowa („Zażółć”: 463 z 1000 przy 50k).
- **S5 trigram** zgadza się z J, z wyjątkiem członów krótszych niż 3 znaki, i ma największy indeks.

### 3.4 Przyczyna wolnej sumy i prototyp trwałej pamięci

**Profil** (`node --cpu-prof`, `reportByDay` + `reportOverlaps` na 2000 wpisach): czas zajmują funkcje polyfillu `@js-temporal/polyfill` i jego arytmetyka JSBI. `calendarPieces` dla każdej nowej doby UTC woła `toZonedDateTimeISO`, `getTimeZoneTransition('next')` i `toZonedDateTime` dla północy. Pomiar:
- `dateInZone` dla 2000 znaczników: 22,5 ms;
- natywny `Intl.DateTimeFormat`: 2,5 ms.

Pamięć dób (`cache`) jest tworzona **na nowo przy każdym wywołaniu** `calendarPieces`, czyli przy każdym `reportByDay` i `reportOverlaps`. Koszt jest więc proporcjonalny do liczby **różnych dób** w danych, a nie do liczby wpisów:
- rzadki wynik rozsiany po 4 latach płaci pełny koszt za prawie każdy wpis (186 wyników → 266 ms);
- wynik z 30 dni jest tani (11 wyników → 18 ms).

Pierwszy pełny raport w prototypie (pusta pamięć: 2,1 s przy 10 000 wpisów ≈ 1500 dób, 5,4 s przy 50 000 ≈ 7400 dób) daje ok. 0,8–1,5 ms na dobę.

**Zmienność obecnego kodu:** w jednym procesie pełny raport 10 000 wpisów trwał w kolejnych wywołaniach 1,10 / 1,06 / 1,37 / 2,12 / 2,17 / 2,16 / 2,19 / 2,14 s. Drugi proces pokazał ten sam wzorzec: 1,07 / 1,01 / 1,21 / 2,12 / 2,11 / 2,11 / 2,16 / 2,17 s. Komputer był na zasilaniu sieciowym, a dane są deterministyczne, więc to cecha kodu, nie przypadek. Przyczyny nie badałem (prawdopodobnie GC albo zmiana poziomu optymalizacji V8 w polyfillu); dlatego podaję zakres 1,0–2,2 s. Prototyp z ciepłą pamięcią: pełny raport 10 000 wpisów 78,5 / 99,9 ms (mediana / p95).

**Prototyp** (`docs/tech14/bench-cache-proto.mjs`): kopia modułów raportu w katalogu tymczasowym. Jedyna zmiana: mapa dób jest trwała na poziomie modułu, z kluczem strefy:

```ts
type Slice = { until: number; date: string };
const persistentBuckets = new Map<string, Map<number, Slice[]>>();
function calendarPieces(zone: string) {
  let cache = persistentBuckets.get(zone);
  if (!cache) persistentBuckets.set(zone, cache = new Map<number, Slice[]>());
  // … reszta bez zmian
```

Skrypt porównuje sekundy, oczekujące, wkłady i nakładki z niezmienionym kodem `src/` i przerywa przy różnicy. Dla wszystkich zapytań wynik był identyczny.

#### Prototyp: 10 000 wpisów (Node)

Pierwszy pełny raport (pamięć pusta): 2107 ms; pełny raport, pamięć ciepła: 78.5 / 99.9 ms.

| Zapytanie | Wyniki | Suma (makeReportView), pamięć ciepła | Wynik = obecny kod |
|---|---:|---:|---|
| `zolc` | 186 | 1.44 / 5.74 | identyczny |
| `lodz` | 112 | 1.43 / 2.52 | identyczny |
| `spotkanie` | 866 | 9.32 / 14.49 | identyczny |
| `studio lak` | 1266 | 11.11 / 12.21 | identyczny |
| `a` | 10000 | 104.46 / 126.19 | identyczny |
| `xqzv` | 0 | 0.11 / 0.44 | identyczny |

#### Prototyp: 50 000 wpisów (Node)

Pierwszy pełny raport (pamięć pusta): 5419 ms; pełny raport, pamięć ciepła: 356.2 / 444.8 ms.

| Zapytanie | Wyniki | Suma (makeReportView), pamięć ciepła | Wynik = obecny kod |
|---|---:|---:|---|
| `zolc` | 1000 | 9.17 / 19.11 | identyczny |
| `lodz` | 543 | 5.31 / 9.47 | identyczny |
| `spotkanie` | 4226 | 32.11 / 38.13 | identyczny |
| `studio lak` | 6286 | 51.37 / 57.73 | identyczny |
| `a` | 50000 | 561.84 / 689.70 | identyczny |
| `xqzv` | 0 | 0.09 / 0.16 | identyczny |

Granice dób zależą tylko od strefy i danych tzdata wbudowanych w polyfill, a te są stałe w czasie życia procesu. Pamięć rośnie o jeden wpis na dobę: 20 lat ≈ 7400 dób, czyli pomijalnie.

## 4. Spójność z Raportem i Historią (AC2)

### 4.1 Zasada

Suma wyniku liczy się **tylko** funkcją Raportu, bez własnej arytmetyki czasu. Wynik dla frazy *q* i zakresu [od, do] jest równy temu, co pokazałby Raport z zakresem [od, do], gdyby zawierał tylko wpisy pasujące do *q*:
- segmentacja przez północ i zmianę czasu (TECH-09 / D12);
- sekundy z kotwicą początku wpisu, jak `reportByDay`;
- uśpienie: `excluded` nie jest liczone, `pending` jest pokazywane osobno jako „oczekuje na decyzję” i nie wchodzi do sumy, `included` i `auto_included` są pracą;
- aktywny pomiar tylko rozstrzygnięty.

### 4.2 J3: suma z wkładów, równa co do sekundy

1. **Raport bazowy:** raz na odczyt danych (zmiana `allClients.read`) i na zakres dat: `base = makeReportView(daneWszystkich, katalog, allReportClients, od, do)`, a z niego `Map(id → contribution)`.
2. **Przy każdej zmianie frazy:** filtr J1 → Σ `contribution.seconds` i Σ `contribution.pendingSeconds` pasujących wpisów.

Dlaczego wynik jest identyczny:
- w `reportByDay` suma (`totalSeconds`) jest sumą sum dni;
- suma dnia to suma części dni poszczególnych wpisów (`addEntry` → `addDaySeconds`);
- części wpisu zależą tylko od wpisu, strefy i zakresu, a nie od innych wpisów;
- wkład wpisu (`contribution.seconds`) to suma jego części w zakresie;
- czas oczekujący sumuje się tak samo.

Skrypt sprawdza to dla każdego zapytania, także dla zakresu 30 dni: J3 = `makeReportView` na samych wynikach, sekundy i oczekujące, przy 10 000 i 50 000 wpisów (kolumna AC2 w §3.2). Wyjątki opisane w Raporcie zachowują się tak samo:
- wpisy niespójne (`excludedEntryIds`) nie mają wkładu i są pokazywane z ostrzeżeniem jak w Raporcie;
- nakładki (`overlaps`) są ostrzeżeniem, a nie częścią sumy.

### 4.3 Historia w trybie wyszukiwania

- Wynik grupujemy po dniach jak Historię: wpis przez północ jest w obu dniach z sekundami tego dnia.
- **Suma w nagłówku dnia to suma pasujących wpisów tego dnia**, a nie suma wszystkich klientów. Liczy się ją z tych samych wkładów (`contribution.days`).
- Obecny `historyDays` liczy `makeReportView` na danych, które dostaje. Przy dużych wynikach jest dziś najwolniejszym krokiem (§3.2). DEV-41 powinien:
  - przekazać mu gotowe wkłady (czysta zmiana API, testy jak dziś);
  - renderować strony po 100 wierszy („Pokaż kolejne”), przy czym suma i liczba wyników zawsze dotyczą całego wyniku.
- Po edycji, usunięciu lub wznowieniu z wiersza wyniku `reportRevision` odświeża odczyt, a wynik liczy się ponownie z tą samą frazą.

## 5. Interfejs

| Temat | Propozycja |
|---|---|
| Miejsce | Karta „Historia pomiarów”: pole „Szukaj w historii” w nagłówku karty, obok licznika, a pod nim zakres dat (okresy + własny). **Kalendarz: nie w V1.1** (ma już filtry klient/projekt/zadanie; decyzja D-2). |
| Klawiatura | `Ctrl+F` w głównym oknie: przełącza na widok Timer, jeśli trzeba, przewija do Historii i ustawia fokus w polu, z `preventDefault`. `Esc` w polu: pierwsze czyści frazę, drugie zdejmuje fokus. `Enter` nic nie wysyła (filtr działa na bieżąco). Konflikty: domyślny skrót globalny to `Ctrl+Shift+Space`, więc brak kolizji. **Do sprawdzenia w E2E:** czy WebView2 nie pokazuje własnego paska wyszukiwania po `Ctrl+F` mimo `preventDefault`. |
| Reakcja | Filtr przy każdym znaku, bez opóźnienia przy J1+J3 (≤ 21 ms, mediana przy 50k). Raport bazowy przy zmianie zakresu lub odczytu przez `useDeferredValue` lub po bezczynności, ze stanem „Liczenie sumy…” zamiast starej liczby. |
| Wynik | Nagłówek: „12 wpisów · 3 h 25 min” (+ „· 40 min oczekuje na decyzję”, jeśli dotyczy) z `aria-live="polite"`. Wiersze jak w Historii, z tymi samymi operacjami. Podświetlenie dopasowania `<mark>` w tokenach to decyzja D-6. |
| Stan pusty | „Brak wpisów pasujących do „xyz”” (+ zakres dat, jeśli ustawiony) i przycisk „Wyczyść wyszukiwanie”. Osobny komunikat, gdy dane są niedostępne: „Wyszukiwanie będzie dostępne po odczytaniu danych”. |
| Czyszczenie | Przycisk „×” w polu (`aria-label="Wyczyść wyszukiwanie"`, 40×40 px) i `Esc`. Po wyczyszczeniu wraca zwykła Historia (500 ostatnich) z poprzednim przewinięciem. |
| UIQ | Kontrolki ≥ 40 px (`--control-h`), cel „×” 40×40. Kolory tylko z tokenów `:root`; `designTokens.test.mjs` pilnuje kontrastu ≥ 4,5:1, w tym `--color-text-muted` na tle karty. Widoczny `:focus-visible`. Etykieta pola widoczna albo `aria-label` + `placeholder` niebędący jedyną etykietą. Szerokość 1024 px przy 125% DPI: pole i zakres w jednym rzędzie lub zawijane bez poziomego przewijania (asercja `UI_LAYOUT`). |

## 6. Prywatność

- **Fraza żyje tylko w stanie React okna.** Nie trafia do `localStorage`, `sessionStorage`, URL, szkiców wpisów (`entry-drafts`), Notion ani logów. Znika po zamknięciu okna. Jest to świadomy wyjątek od zapamiętywania filtrów raportu i kalendarza.
- Zakres dat wyszukiwania też nie jest zapamiętywany (propozycja, decyzja D-3).
- W wariancie J fraza nie przechodzi przez IPC do Rust. Wariant SQLite wymagałby jej przesłania (dziś bez logowania, ale większa powierzchnia).
- Testy prywatności:
  1. statyczny test node: moduł wyszukiwania i komponent nie odwołują się do `localStorage`, `sessionStorage` ani `console`;
  2. E2E: po wyszukaniu frazy kontrolnej żaden klucz ani wartość `localStorage` jej nie zawiera.

## 7. Testy i kryteria akceptacji

| AC (PTT-63) | Testy |
|---|---|
| **AC1.** Fraza z opisu zwraca dokładnie pasujące wpisy; „zolc” znajduje „żółć”. | Testy jednostkowe `foldText` i wyszukiwania: „zolc” → „żółć”, „ŻÓŁTY”, „Zażółć”; „lodz” → „Łódź”; wielkość liter; NFC/NFD; kilka członów (AND); pusta fraza; brak wyników; nazwy klienta, projektu i zadania; zarchiwizowane; usunięte nie występują. E2E: wpisy z opisami przez `create_project_manual_entry`, wpisanie „zolc”, oczekiwana dokładna lista identyfikatorów. |
| **AC2.** Suma czasu wyniku = suma tych wpisów w Raporcie. | Test jednostkowy: J3 = `makeReportView` na wynikach (sekundy i oczekujące) dla losowych fraz na danych deterministycznych, wpisów przez północ, obu dni zmiany czasu, uśpienia `pending`/`excluded`/`included`/`auto_included`, zakresu przycinającego wpis i rozstrzygniętego aktywnego pomiaru. Kontrakty TECH-09/TECH-10 bez zmian. E2E: fraza równa nazwie klienta daje sumę równą Raportowi z zakresem tego klienta i tym samym okresem. |
| **AC3.** 10 000 wpisów: wynik w < 200 ms na typowym komputerze. | Proponowane brzmienie: „10 000 wpisów: od znaku do liczby wyników i sumy < 200 ms (mediana) na komputerze referencyjnym z §3.1, przy ciepłym raporcie bazowym; raport bazowy po zmianie zakresu < 500 ms”. Zmierzone: J1 + J3 ≤ 2,5 ms (10k, mediana), a raport bazowy po prototypie ≈ 80 ms (10k) / ≈ 360 ms (50k). **Bez trwałej pamięci AC3 nie jest spełnione** przy zmianie zakresu i pierwszym wyszukiwaniu (1,0–2,2 s przy 10k, cała historia). W CI: test regresji złożoności (np. raport bazowy na 10 000 wpisach drugi raz ≥ 5× szybciej niż pierwszy), bez sztywnych progów czasu na zmiennych maszynach CI; pomiar bezwzględny `docs/tech14/*` przy odbiorze. |
| Dodatkowe | `Ctrl+F` / `Esc` / „×” w E2E; `UI_LAYOUT` przy 1280×720 i 1024×576 (125%) bez poziomego przewijania, kontrolki ≥ 40 px; testy prywatności z §6; `designTokens` i `previewIsolation` bez zmian; podgląd `preview:ui` z danymi do wyszukania. |

## 8. Rekomendacja, podział na PR-y, ryzyka i decyzje

### 8.1 Rekomendowany wariant

Wariant **J1 + J3**: filtr JS na indeksie znormalizowanego tekstu i suma z wkładów jednego raportu bazowego. Warunek wstępny: trwała pamięć granic dnia w `reportTime`. Bez zmian w Rust, schemacie i IPC.

### 8.2 Podział na PR-y

| PR | Zakres | Dowody |
|---|---|---|
| **1. TECH-15 (proponowana karta): trwała pamięć granic dnia w `reportTime.calendarPieces`** | 5 linii z §3.4, bez zmiany wyników. Osobny PR, bo dotyczy Raportu, karty raportu, kalendarza i Historii, nie tylko wyszukiwania. | Kontrakty TECH-09/TECH-10 i wszystkie testy raportu bez zmian; nowy test: drugi raport identyczny i szybszy; pomiar `bench-cache-proto` przed/po. |
| **2. DEV-41a: czysty moduł `src/historySearch.ts`** | `foldText`, indeks, filtr, zakres, J3 (suma i dni z wkładów). Bez UI. | Testy jednostkowe AC1/AC2 z §7, wpis w workflow „Check report calculations”. |
| **3. DEV-41b: UI w Historii** | Pole, zakres, wynik, stan pusty, czyszczenie, `Ctrl+F`/`Esc`, stronicowanie wierszy, `historyDays` z gotowymi wkładami. Mock w `preview/mockCore.ts`, zrzuty 1280×720 i 125%. | `designTokens`, `previewIsolation`, test prywatności statyczny, zrzuty. |
| **4. DEV-41c: E2E `history-search`** | Faza w `tests/windows-application.mjs` (tylko dopisanie): AC1, AC2 względem Raportu, klawiatura, `UI_LAYOUT`, `localStorage` bez frazy, czas od wpisania do wyniku z `performance.now()` w WebView2 na 10 000 wpisów. | Log CI z PASS i `UI_LAYOUT`. |

PR 2 można robić równolegle z 1. PR 3 wymaga 1 i 2, PR 4 wymaga 3.

### 8.3 Ryzyka

| Ryzyko | Skutek | Ograniczenie |
|---|---|---|
| Koszt Raportu rośnie z liczbą dób także **poza wyszukiwaniem**: Raport „cały okres” przy 10 000 wpisach to 1,0–2,2 s w wątku UI (dziś, bez wyszukiwania). | Zamrożenie okna przy długich zakresach. | PR 1 (TECH-15) poprawia to dla wszystkich widoków; zgłosić niezależnie od PTT-63. |
| Ładunek `get_report_data` rośnie liniowo: 2 MB (10k) / 10 MB (50k), `JSON.parse` 4–62 ms, co 60 s i po zmianach. Dzieje się to już dziś. | Pamięć i krótkie przycięcia przy bardzo dużych bazach. | Poza zakresem PTT-63; przy > 50k rozważyć odczyt przyrostowy. |
| Pierwszy raport po starcie nadal płaci ok. 0,8–1,5 ms za dobę (zimna pamięć: 2,1 s / 5,4 s przy 10k / 50k). | Pierwsze wyszukiwanie „cały okres” wolniejsze. | Domyślny zakres wyszukiwania „ostatnie 12 miesięcy” (decyzja D-5) albo ogrzewanie pamięci po starcie w bezczynności. |
| Litery spoza polskiego alfabetu bez rozkładu (`ø`, `ß`, `đ`). | „oslo” nie znajdzie „Øslo”. | Poza zakresem V1.1; mapa w jednym miejscu. |
| `Ctrl+F` w WebView2. | Pasek wyszukiwania przeglądarki zamiast pola aplikacji. | E2E w DEV-41c; awaryjnie wyłączyć klawisze akceleratora przeglądarki dla `Ctrl+F` tylko w głównym oknie. |
| Pomiar na jednym laptopie. | Inne maszyny mogą być wolniejsze. | Zapas: J1 + J3 ≤ 21 ms (mediana) przy 50k; pomiar w E2E na runnerze CI jako drugi punkt odniesienia. |

### 8.4 Decyzje właściciela

| ID | Pytanie | Rekomendacja |
|---|---|---|
| D-1 | Operatory w frazie (cudzysłów, `-`, `OR`)? | Nie w V1.1: zwykły tekst, człony AND. |
| D-2 | Wyszukiwanie także w Kalendarzu? | Nie w V1.1: tylko Historia. |
| D-3 | Zapamiętywać zakres dat lub frazę między uruchomieniami? | Nie zapamiętywać niczego. |
| D-4 | Wpisy zarchiwizowanych klientów, projektów i zadań w wynikach? | Tak, jak w Raporcie. |
| D-5 | Domyślny zakres: cała historia czy ostatnie 12 miesięcy? | Cała historia po TECH-15; bez TECH-15 tylko 12 miesięcy. |
| D-6 | Podświetlać dopasowanie w opisie? | Tak, jeśli zmieści się w tokenach i kontraście; inaczej później. |
| D-7 | Brzmienie AC3 (§7) i komputer referencyjny. | Przyjąć brzmienie z §7 i komputer z §3.1. |
| D-8 | Zgoda na TECH-15 (zmiana w `reportTime`, bez zmiany wyników) przed DEV-41. | Tak. |
