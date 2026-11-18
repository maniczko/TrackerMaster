# TECH-10 — kontrakt raportów, agregacji i eksportu (audyt 18.11.2026)

**Status:** kompletna specyfikacja techniczna do zamknięcia TECH-10, względem zatwierdzonych D7 i D12 z 17.11.2026. **Zakres:** zasady raportowania i testy kontraktowe istniejących funkcji. Nie jest to odbiór DEV-30/32/35, rzeczywistego Windows 11 E2E ani Store MSIX.

## Kontrakt spójnych sum i filtrów

1. Źródłem trwałych pozycji jest SQLite, z relacją clientId→projectId→entryId i opcjonalnym taskId. Nazwy w raportach pobierane są z bieżących nazw powiązanych obiektów; archiwizacja nie usuwa historii. Dla dwóch klientów podobne nazwy projektu nie mogą przełamać granicy danych.
2. Dla tego samego ustawienia IANA, lokalnego zakresu [początek, koniec dnia następnego), klienta i pozostałych zgodnych filtrów: **finalizedSeconds** = suma wkładów (contributionSeconds) w kalendarzu = suma wkładów w Detailed (bez duplikacji entryId) = suma kolumny 11 CSV *dla jednego, jawnie wybranego klienta*.
3. **liveSeconds** = finalizedSeconds + runningProvisionalSeconds. Running widoczny z osobną etykietą, ale poza eksportem i zatwierdzonymi sumami. Niepewne/różnie rozstrzygnięte uśpienia należy trwale oddzielić; pendingSeconds nie należą do live/work/billable/CSV. Po Stop następuje jedno przejście do finalized; nie sumować projekcji ponownie.
4. **Średnio na dzień z pracą** = suma zaliczonych sekund / liczba lokalnych dni, w których wkład jest dodatni. Dni zerowe pomijane, weekendy z pracą wliczane. Pusty zakres ma wartość null/„Brak danych”, nigdy NaN.
5. Nowe billable jest boolean true/false; jego domyślna wartość pochodzi z projektu, inaczej false. **Billable%** = billableSeconds / totalWorkSeconds × 100, przy tych samych filtrach i polityce live/finalized. Obliczać na sekundach, zaokrąglać dopiero przy wyświetlaniu.
6. Detailed i CSV mają *jeden wiersz na źródłowy ukończony entryId*, nawet gdy odcinki czasu przecinają granice dni. Dwa osobne pola: całkowity czas oryginalnego wpisu i **czas w wybranym okresie**. Do KPI agregować tylko to drugie. Rzeczywiste zatwierdzone odcinki czasu rozcinać w strefie IANA (patrz TECH-09), nigdy sztywnym czasem +01:00.

## Kontrakt CSV i bezpieczeństwo

- Backend wymaga **dokładnie jednego stabilnego clientId**, filtruje w zapytaniu SQLite, a nie tylko w komponencie React. Wersja produkcyjna posiada już filtrowanie po `p.client_id=?1` w `client_export_data`; sprawdzono to w kodzie, ale nie przeprowadzono w tej pracy rzeczywistych testów SQLite na instalacji Windows. `makeClientExportRows` wykonuje dodatkowe sprawdzenie zgodności nazwy klienta i nie może zastąpić filtra po ID.
- Jawny raport `allClients` może być zbiorczy **wewnątrz aplikacji**; zapis CSV `allClients`, brak ID, ID nieaktywne lub wiersze obcego klienta powinny być odrzucone przed zapisem. Podgląd i eksport odwołują się do tych samych zakończonych danych i filtrów; użytkownik musi zatwierdzić pobranie.
- 12 polskich kolumn w ustalonej kolejności: `ID wpisu`; `Klient`; `Projekt`; `Zadanie`; `Opis`; `Start`; `Koniec`; `Rozliczalność`; `Czas całkowity w sekundach`; `Czas całkowity HH:MM:SS`; `Czas w wybranym okresie w sekundach`; `Czas w wybranym okresie HH:MM:SS`. Realizacja ma odzwierciedlać zatwierdzony kontrakt D12.
- CSV: **UTF-8 BOM dokładnie raz** (EF BB BF), separator średnik, rekordy CRLF i poprawne cytowanie pól z CR/LF, średnikiem i cudzysłowem; escapowanie formuł w tekstach, bez zmiany danych oryginalnych. Lokalny ISO8601 z przesunięciem UTC odpowiednim dla IANA w chwili startu i końca, sekundy bez zaokrągleń. `Tak/Nie` dla billable, >24h nie zawija w HH:MM:SS.
- Brak zadania = poprawny wpis z `taskId=null` i pustym polem zadania w CSV; brak opisu = pusty tekst. Zmiana nazwy klienta/projektu/zadania nie powoduje zmiany entryId ani godzin.
- Obrona warstwowa: duplikat ID, niespójna długość, niepoprawny timestamp i zadanie obcego projektu mają być odrzucane lub blokowane do korekty; nie wolno częściowo zapisać pliku zawierającego niewiarygodne dane.

## Testy i dowody

`tests/reportContract.test.ts` wykonuje **11 testów na istniejących funkcjach produkcyjnych** `src/reportTime.ts` i `src/reportCsv.ts`: dopasowanie Calendar/Detailed/CSV, Jan/Feb i zmiana Warsaw/London, jednorazowe ID, dwaj klienci o podobnym projekcie, rzeczywisty zapis/odczyt pliku z dokładnym BOM i CRLF, round-trip znaków polskich, cudzysłowów, separatora i nowej linii, CSV injection, średnia z pracujących dni w tym weekend, billable z contributionSeconds, odrębny running, odrzucanie błędnych danych, sekundy >24 h i offsety DST. Test jest uruchamiany na `windows-latest` w GitHub Actions.

**Uwaga audytowa — różnica etykiet CSV:** w `src/reportCsv.ts` cztery nagłówki z czasem używają obecnie nawiasów (np. `Czas całkowity (sekundy)`) zamiast dosłownego tekstu specyfikacji D12 (`Czas całkowity w sekundach`). Kolejność, semantyka i liczba kolumn się zgadzają; zgodność dokładnych etykiet pozostaje do weryfikacji/poprawienia w implementacyjnym DEV-35. Testy TECH-10 weryfikują semantyczne 12 kolumn, **nie udają pełnej akceptacji etykiet przez PO**. Współdzielony plik CSV służy też do QA w Microsoft Excel, którego nie symuluje automatyczne parsowanie Node.

**Niepotwierdzone testami kontraktu:** rzeczywiste SQLite i instalacja MSIX, manualny import do polskiego Excela, UI i zmiana filtrów po restarcie, trwały stan pending, plik w docelowej ścieżce Windows i wydajność. Wcześniejsze SLO p95 < 1 sekundy dla 10 tys. wpisów pozostaje propozycją benchmarku DEV-36/QA-06, nie zaliczonym wynikiem.

## Kryterium ukończenia TECH-10

Dokument techniczny, jednoznaczne invariants i testy kontraktowe plus niezależny przegląd i potwierdzony Windows CI PASS. Po zaliczeniu **TECH-10 może mieć „Zrobione” wyłącznie jako analiza/kontrakt**. DEV-30, DEV-32, DEV-35, DEV-15 i QA-01 pozostają do implementacji/odbioru według własnych kart. Formalna akceptacja biznesowa samej karty TECH-10 przez PO nie jest przypisywana automatycznie.

Źródła: Notion TECH-10 (praca 15–17.11.2026), końcowy D12 (17.11.2026), D7; TECH-09 (PR #14), docs/QA-MVP-ACCEPTANCE-MATRIX.md.
