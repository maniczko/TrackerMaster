# TECH-09 — zatwierdzony kontrakt segmentacji czasu (przegląd techniczny 18.11.2026)

**Zakres:** projekt interfejsu czasu dla Calendar i powiązanych agregacji, według zatwierdzonych decyzji D4/D5/D7/D10/D12. **Nie jest to implementacja DEV-27 ani odbiór QA-01.**

## Kontrakt źródła i DTO

- TimeEntry jest trwałą pozycją SQLite; entryId i relacja clientId → projectId nie zmieniają się podczas rozcinania czasu. TaskId jest opcjonalne (null), opis opcjonalny, a billable dla nowych wpisów to true/false.
- Start i koniec zakończonego wpisu to instants UTC; ukończony wpis ma start przed końcem. Różnica instants daje rzeczywiste sekundy, nie różnica lokalnych wskazań zegara.
- TimeSegment jest **wyłącznie wyliczonym DTO**: entryId, clientId, projectId, taskId, billable, state, originalStartUtc, originalEndUtc, segmentStartUtc, segmentEndUtc, localDate, segmentSeconds. Jedna pozycja bazowa może dać wiele segmentów, ale nie zmienia się w bazie.
- Zakres doby wyznaczają **dwie kolejne lokalne północe w ustawionej strefie IANA**, domyślnie Europe/Warsaw. Dzień DST ma 23 lub 25 godzin. Segment jest półotwarty [start,end); sekundy dodatnie, bez zaokrąglania. Zmiana strefy Windows bez zmiany reportTimezone nie zmienia wyniku.
- Po świadomej zmianie reportTimezone przelicz wszystkie segmenty historyczne; zachowaj źródłowe instants i oryginalne lokalne daty filtra, ale ponownie wylicz odpowiadające im granice UTC. Przeliczenie Warszawa → Londyn → Warszawa jest odwracalne.
- Pending sleep zachowuje odrębne identyfikatory i pozostaje poza potwierdzonymi sumami, billable i CSV. Odcinki zaliczone do pracy (eligibleIntervals) muszą być jawnie kwalifikowane przez decyzję użytkownika, atomowo i idempotentnie zapisaną poza tym modułem. Brak wiarygodnych granic wymaga rozstrzygnięcia; nie wolno automatycznie przyjąć całego czasu między start i end jako pracy.
- Running/unresolved są osobną klasą prezentacji live, a nie częścią finalized/CSV. Nakładanie historycznych wpisów nie może być ukryte; nowy zapis według reguł D10.
- Calendar agreguje wkłady segmentów. Detailed/CSV prezentuje **jeden wiersz na ukończone źródłowe entryId** i oddzielnie cały czas oraz wkład do zakresu. Eksport obejmuje dokładnie jednego jawnie wybranego klienta, a filtry wymusza backend; referencyjny JS nie stanowi warstwy bezpieczeństwa.

## Wydajność i zależności implementacyjne

Do produkcyjnego źródła SQLite w DEV-27: pobierać wpisy nachodzące na wybrany zakres UTC, stosować clientId i projectId przed przekazaniem do UI; zalecane indeksy (client_id,start_utc), (project_id,start_utc) oraz plan zapytań obejmujący wpisy zaczynające się przed oknem. Paginacja po startUtc i entryId. Osobno zweryfikować EXPLAIN QUERY PLAN oraz p95 dla 10 tys. wpisów — w tym TECH-09 nie zmierzono rzeczywistej wydajności.

## Weryfikacja kontraktu

- Referencja: tests/contracts/time-segmentation.mjs — obliczeniowy model z IANA poprzez @js-temporal/polyfill, *niepodłączony do produkcyjnego backendu*.
- Regresje: tests/time-segmentation-contract.test.mjs — 16 testów: północ 600+600, dwie granice DST i doba 23/25 h, wpis 54h, półotwarte granice, dwóch klientów A/B (7200/10800), resegmentacja strefy, zachowanie lokalnego filtra, running/pending, dwa okresy uśpienia, brak jawnych danych, integralność i błędne daty.
- Uruchomienie: npm ci; node --test tests/time-segmentation-contract.test.mjs.
- CI: Windows runner uruchamiany na PR/push w przypadku zmian dokumentu, kontraktu lub testów. Pozostałe istniejące CI aplikacji działa niezależnie.

## Granice zamknięcia TECH-09

Odbiór **kontraktu technicznego** może zostać zakończony po potwierdzonym PASS jego testów i niezależnym review. Nie oznacza to ukończenia DEV-27, DEV-15, QA-01, rzeczywistego eksportu CSV/SQLite ani Microsoft Store MSIX, potwierdzenia uśpienia na urządzeniu lub wydajności 10k wpisów. Te elementy nadal wymagają testów i dowodów w swoich kartach. Formalne Akceptacja PTT/PO pozostaje odrębna.

Źródła: Notion TECH-09 i jego dokument v0.1, TECH-10 oraz finalny D12 (17.11.2026); docs/QA-MVP-ACCEPTANCE-MATRIX.md.
