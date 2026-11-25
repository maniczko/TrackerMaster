# TECH-12 — bezczynność i przypomnienia (analiza 24.11.2026, poprawki po recenzji i decyzje 25.11.2026)

**Zakres:** analiza i rekomendacja dla PTT-61 („Bezczynność i przypomnienia”, Should, V1.1). Jeden użytkownik, wyłącznie lokalnie, Windows 11 x64. **Dokument nie zawiera kodu aplikacji i niczego nie implementuje.** Implementacja to DEV-39, po przeglądzie tego dokumentu. Decyzje O1–O9 właściciel zatwierdził 25.11.2026 (§7).

**Stan bazy odniesienia:** `main` @ `de9091e` (kod Rust bez zmian względem `f2a3386`, na którym powstała pierwsza wersja), schemat v14 (`LATEST_SCHEMA_VERSION = 14`). Obowiązują: D3 (jeden aktywny timer, przełączenie w jednej transakcji), D4 z regułą krótkiego uśpienia < 5 min (#62, `SHORT_SLEEP_AUTO_INCLUDE_MS`), D12-A (indywidualne pending, „Później”, baner przy starcie, brak akcji zbiorczych, finalne CSV tylko z rozstrzygniętych wpisów), odzyskiwanie po awarii (#50) i PTT-26.

**Kryteria PTT-61, do których odnosi się analiza:**
- **AC1:** timer 30 min + 15 min bezczynności → po powrocie komunikat z wyborem; czasu nie dolicza się ani nie odrzuca bez decyzji.
- **AC2:** brak podwójnego liczenia z okresami uśpienia (D4).
- **AC3:** przypomnienia nie pojawiają się, gdy timer działa, ani poza godzinami pracy; można je wyłączyć.
- **AC4:** poza progiem i decyzją nic o aktywności użytkownika nie jest zapisywane.

**Oznaczenia wiarygodności:**
- **[źródło]** — fakt sprawdzony w dokumentacji, link w §8.
- **[kod]** — fakt z repozytorium na `de9091e`, z plikiem i linią.
- **[do potwierdzenia]** — nie udało się sprawdzić.
- **BLOCKED** — wymaga Windows 11 x64 i nie jest PASS.

O Toggl Track: strony pomocy Toggl o idle detection i tracking reminders zwracały 404, więc domyślne progi i dokładne przyciski Toggl są **[do potwierdzenia]**. Zgodnie z uwagą w D12 nie przypisujemy Togglowi konkretnych zachowań jako faktu. „Wzorzec Toggl” oznacza tu tylko ogólną ideę z PTT-61:
- wykryć bezczynność przy działającym timerze i zapytać po powrocie;
- przypominać, gdy nic nie jest mierzone albo timer działa za długo.

---

## 1. Wykrywanie bezczynności przy włączonym komputerze

### 1.1 Źródło sygnału: wyłącznie czas ostatniego wejścia

- **API:** `GetLastInputInfo` (user32) wywoływane z Rusta. Zwraca `LASTINPUTINFO.dwTime`, czyli licznik ticków (ms) ostatniego zdarzenia wejścia **w sesji, która wywołała funkcję** [źródło]. Nie zwraca, co zostało naciśnięte ani w którym oknie.
- **Czego nie robimy (twardy zakaz):**
  - brak `SetWindowsHookEx` i hooków klawiatury lub myszy;
  - brak `GetForegroundWindow`, tytułów okien, nazw procesów, zrzutów ekranu i Raw Input.
  - Te ograniczenia sprawdza recenzja kodu i test w §5 (lista importów Win32).
- **Przeliczanie na czas:**
  - bezczynność = `GetTickCount()` (32 bity) − `dwTime`, liczone arytmetyką `wrapping_sub` na `u32`;
  - 32-bitowy licznik przekręca się po ok. 49,7 dnia [źródło: GetTickCount], a różnica modulo 2³² jest poprawna dla bezczynności krótszej niż 49,7 dnia;
  - Microsoft zaznacza, że `dwTime` może być mniejsze od wartości z poprzedniego zdarzenia [źródło]. Jeśli wynik jest „z przyszłości” albo wygląda na wartość po przekręceniu (np. > 49 dni), traktujemy go jako bezczynność 0 i nie otwieramy okresu.
  - Czas ścienny początku bezczynności = `now_utc − idle_ms`, liczony w chwili próbki.
- **Próbkowanie:**
  - wątek w Rust odpytuje co 15 s, **tylko gdy timer działa** (oraz w chwili sprawdzania przypomnień, §2.1);
  - wartość jest trzymana wyłącznie w pamięci, bez logów i bez bazy;
  - dokładność granicy wynika z `dwTime`, nie z interwału próbkowania;
  - interwał decyduje tylko o opóźnieniu wykrycia: najwyżej 15 s.
- **Ograniczenia znane z góry:**
  - wejście wstrzyknięte programowo (np. „mouse jiggler”, narzędzia zdalne) też odświeża `dwTime`, więc bezczynność nie zostanie wykryta;
  - oglądanie wideo albo czytanie bez dotykania myszy da fałszywą bezczynność, a użytkownik wybierze wtedy „Dolicz”.
  - Oba przypadki są akceptowalne, bo decyzja i tak należy do użytkownika.

### 1.2 Próg

- **Domyślnie:** **10 min**, włączone [zatwierdzone 25.11.2026, §7 O1].
- **Konfiguracja:** lista 5 / 10 / 15 / 30 / 60 min oraz „Wyłączone”; bez dowolnej liczby.
  - 5 min to minimum, żeby nie dublować reguły krótkiego uśpienia i nie pytać po każdej przerwie na kawę.
  - Zgodność z AC1: przy progu 10 i 15 min scenariusz „15 min bezczynności” daje pytanie.
- **Bezczynność krótsza niż próg jest pracą** i nic nie zostawia w bazie.
- **Od progu w górę (granica włącznie, jak w D4):** cały odcinek od ostatniego wejścia jest okresem do decyzji, także pierwsze minuty przed przekroczeniem progu. Jest to zachowanie „liczone od ostatniego wejścia”, a nie „od przekroczenia progu”.

### 1.3 Zapis w chwili przekroczenia progu, nie dopiero po powrocie

- Gdy próbka pokaże bezczynność ≥ próg przy działającym timerze, w jednej transakcji powstaje okres `[start = ostatnie wejście, end = NULL)` w stanie `pending` (model w §3).
  - Działa to jak `record_suspend` dla uśpienia [kod: `sleep_periods.rs:104-117`].
  - **Przycięcie początku:** `start = max(now − idle_ms, start wpisu, koniec ostatniego okresu wpisu, t_resume ostatniego wybudzenia)`. `record_suspend` odrzuca start sprzed wpisu [kod: `sleep_periods.rs:112`], a trigger odrzuca nakładanie [kod: `sleep_periods_v14.sql:30-45`]. Dotyczy to np. wpisu uruchomionego albo wznowionego bez wejścia użytkownika (skrót z innego urządzenia, automatyczne wznowienie). Jeśli po przycięciu bezczynność jest krótsza niż próg, okresu nie ma.
- **Dlaczego od razu:** jeśli aplikacja padnie, system się wyloguje albo zabraknie prądu, otwarty okres przetrwa w bazie. Odzyskiwanie z #50 (`resolve_recovered`) przytnie go wtedy do końca wpisu i zostawi jako pending [kod: `main.rs:1048-1070`, `close_open_at_entry_end` w `sleep_periods.rs:159-165`]. Działa to tylko pod warunkiem z §3.1: `close_open_at_entry_end` ustawia `manual_resume=1` [kod: `sleep_periods.rs:162`], więc schemat musi na to pozwolić także dla `idle`. Zapis dopiero po powrocie gubiłby ten przypadek i liczyłby nieobecność jako pracę.
- **Licznik na żywo (O2a, zatwierdzone):** dopóki okres jest otwarty, licznik w oknie głównym i widżecie pokazuje czas potwierdzony, czyli zatrzymany na początku bezczynności, z oznaczeniem „Bezczynność od 10:02”.
  - Pomiar nadal działa; nic nie jest zatrzymywane bez decyzji.
  - **Cofnięcie licznika:** przez pierwsze minuty bezczynności (poniżej progu) licznik rośnie, bo nie wiadomo jeszcze, czy to przerwa. W chwili przekroczenia progu cofa się o próg plus do 15 s opóźnienia próbkowania. Oznaczenie musi to tłumaczyć, np. „Bezczynność od 10:02 — 10 min czeka na decyzję”, żeby użytkownik nie odebrał tego jako utraty czasu. Czas wraca po „Dolicz”.
  - Zgodne z zasadą „nierozstrzygnięte nigdy nie liczone po cichu”.

### 1.4 Powrót: wybór użytkownika (D4, D12-A)

- **Wykrycie powrotu:** pierwsza próbka z nowym `dwTime` zamyka okres na `end = czas nowego wejścia` (jednorazowo, idempotentnie). Potem pokazuje się nieblokujący komunikat w oknie głównym i w widżecie, np.:
  > Nie było Cię 23 min (10:02–10:25). Co zrobić z tym czasem?
- **Akcje:**

| Akcja | Skutek w modelu | Timer |
|---|---|---|
| **Dolicz** | decyzja `included`, jednorazowo | działa dalej |
| **Odrzuć** | decyzja `excluded`, czas nie jest pracą | działa dalej od powrotu |
| **Zatrzymaj o 10:02** | wpis kończy się na początku bezczynności (w przeszłości). Okres zaczyna się w chwili końca wpisu, więc leży w całości poza wpisem i **zostaje `pending`** bez decyzji: `resolve` odmawia decyzji dla okresu zaczynającego się w chwili końca wpisu lub później [kod: `sleep_periods.rs:177`], `pending_sleep` go ukrywa [kod: `main.rs:375`], a `periods_within_entry` pomija [kod: `sleep_periods.rs:221`]. Nie trafia do listy, banera ani sum. **Wymaga nowej komendy** (PR 2, §6): dzisiejsze `transition` kończy wpis na `now` [kod: `optional_task_migration.rs:38-39`], a `completed_periods` odrzuca okres kończący się po końcu wpisu [kod: `sleep_periods.rs:248`]. Nowa komenda w jednej transakcji sprawdza `expected_active_id` i identyfikator okresu, ustawia koniec wpisu na `started_ms` okresu i liczy czas przez `periods_within_entry`, tak jak `resolve_recovered`. | zatrzymany |
| **Później** / X / Esc | zostaje `pending`: na liście „Do rozstrzygnięcia” i w banerze przy starcie (D12-A), poza sumami i finalnym CSV | działa dalej |

- **Zasady wspólne:**
  - Bez akcji zbiorczych (D12-A). Każdy okres bezczynności jest osobną pozycją, jak uśpienie.
  - „Dolicz” i „Odrzuć” muszą być odporne na podwójne kliknięcie, restart i błąd SQLite, jak `resolve` dla uśpienia.
  - W UI używamy bramki zapisu (`createRequestGate`).
  - „Przypisz ten czas do innego projektu” **nie wchodzi** do V1.1: wymaga reguł D10 o nakładaniu i nowego wpisu (możliwe rozszerzenie później).
  - Brak decyzji nigdy nie dolicza ani nie odrzuca czasu (AC1).
- **Stop, przełączenie (D3) i wznowienie przy otwartym okresie bezczynności:**
  - **Problem w obecnym kodzie:** zwykły Stop, przełączenie i wznowienie liczą czas przez `active_projection` → `completed_periods` [kod: `optional_task_migration.rs:39-48`], a ta odrzuca każdy otwarty okres [kod: `sleep_periods.rs:247`]. Wynik `None` oznacza odmowę zakończenia; przy otwartym okresie `keeps_clock_for_open_sleep` każe uzupełnić „czas wybudzenia” [kod: `main.rs:893-900`]. `close_open_at_entry_end` jest wywoływane wyłącznie w `resolve_recovered` [kod: `main.rs:1064`], a nie przy Stop i przełączeniu.
  - **Nie jest to przypadek teoretyczny:** przy próbkowaniu co 15 s użytkownik, który wraca i od razu klika Stop albo przełącza zadanie, trafia w jeszcze otwarty okres.
  - **Reguła:** Stop, przełączenie i wznowienie (`transition`) w **tej samej transakcji** najpierw zamykają otwarty okres `idle` aktywnego wpisu na chwilę akcji (kliknięcie albo skrót to wejście, więc to jest powrót), zapisują go jako `pending` (osobna pozycja do decyzji), a dopiero potem liczą projekcję. Otwarty okres `sleep` jest obsługiwany jak dziś.
  - Po przełączeniu okres zostaje przy wpisie A jako pending; B startuje czysto. W każdej chwili nadal jest najwyżej jeden aktywny timer.

### 1.5 Spójność z uśpieniem (D4, #62)

Zasada nadrzędna: **jedna oś czasu wpisu, odcinki bez nakładania i bez dziur.** Każdy fragment wpisu jest dokładnie jednym z:
- praca (obecność albo bezczynność poniżej progu);
- okres bezczynności;
- okres uśpienia.

| Sytuacja | Reguła |
|---|---|
| **Bezczynność, potem uśpienie** (komputer sam usypia po 30 min) | W `handle_suspend`, w jednej transakcji: najpierw zamknij otwarty okres bezczynności na `t_suspend`, potem sprawdź zegar **tylko na okresach `sleep`** (§1.7, B1), potem otwórz uśpienie od `t_suspend`. Dziś `known_sleep` zwraca błąd przy jakimkolwiek otwartym okresie i sumuje wszystkie okresy [kod: `power_events.rs:74-85`], więc bez tej kolejności i filtra sen nie zostałby zapisany. Odcinki półotwarte `[a, t)` i `[t, b)` się nie nakładają. Przy szybkim powrocie oba okresy trafiają do jednego komunikatu jako osobne pozycje. |
| **Wybudzenie po uśpieniu** | Licznik ticków może obejmować czas snu, dlatego **nie** wyprowadzamy początku bezczynności z `dwTime` sprzed snu. Przy `PBT_APMSUSPEND` aplikacja zapamiętuje w pamięci `dwTime` i czas ścienny ostatniego wejścia. Po wybudzeniu: jeśli `dwTime` się nie zmienił, nieobecność trwa od tego zapamiętanego czasu; jeśli się zmienił (wybudzenie klawiszem lub myszą), użytkownik wrócił. Nowy okres bezczynności po wybudzeniu zaczyna się najwcześniej od `t_resume`, nigdy wewnątrz uśpienia. |
| **Próg liczony dla całej nieobecności** | Próg porównujemy z nieobecnością liczoną od ostatniego wejścia (czas ścienny, łącznie ze snem), ale okresy bezczynności zapisujemy tylko dla części „obudzonych”. Przykład: ostatnie wejście 10:00, sen 10:05–10:07, próg 10 min → o 10:10 powstaje okres bezczynności `[10:07, …)`. Odcinek 10:00–10:05 jest za krótki, żeby go zapisać osobno: patrz następny wiersz. |
| **Krótki sen < 5 min w trakcie nieobecności** | Dziś #62 dolicza go automatycznie, a decyzja `auto_included` jest niezmienna [kod: trigger `sleep_periods_immutable`]. **Zatwierdzone (O5a, 25.11.2026):** jeśli w chwili uśpienia był otwarty okres bezczynności, `record_resume` **nie** stosuje automatycznego doliczenia; sen zostaje pending razem z bezczynnością. Ponieważ bezczynność jest już zamknięta na `t_suspend` (`sleep_periods_one_open`), warunek zapisujemy jako: „istnieje okres `idle` tego wpisu z `ended_ms = started_ms` snu”. Sprawdza go `record_resume` w tej samej instrukcji; dziś decyduje on tylko po długości [kod: `sleep_periods.rs:124-135`]. Alternatywa to flaga przekazana z `handle_suspend`; rekomendujemy warunek w bazie, bo przetrwa restart. Jeśli próg przekroczono dopiero po wybudzeniu, krótki sen zostaje `auto_included` jak dziś. Po cichu doliczona nieobecność jest wtedy ograniczona progiem bezczynności, tak samo jak zwykła bezczynność poniżej progu. Odcinki obudzone sprzed snu (10:00–10:05) w tym wariancie są pracą. Pełne „sklejanie” nieobecności przez sen to większa zmiana; nie rekomendujemy jej w V1.1. |
| **Sen ≥ 5 min albo niezakończony** | Bez zmian: D4-A, pytanie i pending. |
| **Brak podwójnego liczenia (AC2)** | Gwarantuje to schemat: wspólny zakaz nakładania odcinków jednego wpisu, niezależnie od rodzaju (§3), a nie tylko kod. |
| **Niespójne zegary** | Ochrona `active_projection` (porównanie czasu snu z liczników zasilania z sumą zapisanych okresów) zostaje, ale **musi sumować tylko okresy `sleep`** (§1.7, B1). Okres bezczynności to czas na jawie, więc wliczony do tej sumy rozjechałby ją już przy jednym wierszu ≥ 5 min. Przy rzeczywistym rozjechaniu zegarów projekcja jest „niepewna”, bez cichego zapisu. |

### 1.6 Blokada ekranu, pulpit zdalny, wylogowanie

- **Zasada:** to osobne przypadki, ale **v1 nie potrzebuje do nich osobnej logiki zapisu**. Wystarcza `GetLastInputInfo`. Zdarzenia sesji tylko doprecyzowują granice.
- **Blokada (Win+L) i odejście:**
  - ostatnim wejściem jest naciśnięcie Win+L, więc bezczynność liczy się od blokady;
  - **[do potwierdzenia, BLOCKED]** czy wpisanie PIN-u na ekranie blokady odświeża `dwTime` w sesji użytkownika (ekran blokady jest osobnym pulpitem). Jeśli nie, powrót wykryje pierwsze wejście po odblokowaniu; jeśli tak, granica przesunie się o czas logowania. Oba przypadki są bezpieczne: okres jest pending i decyduje użytkownik.
- **Zdarzenia sesji (opcjonalny PR, §6):** `WTSRegisterSessionNotification` z `NOTIFY_FOR_THIS_SESSION` wymaga uchwytu okna [źródło]. Używamy własnego okna tylko do komunikatów (`HWND_MESSAGE`) w osobnym wątku, nie okna Tauri. **[do potwierdzenia]**: czy okno typu message-only dostaje `WM_WTSSESSION_CHANGE` (strona MS mówi tylko o „uchwycie okna”); jeśli nie, potrzebne jest ukryte okno najwyższego poziomu. Do sprawdzenia w PR 5. Zdarzenia `WM_WTSSESSION_CHANGE`:
  - `WTS_SESSION_LOCK` i `UNLOCK`;
  - `WTS_REMOTE_CONNECT` i `DISCONNECT`;
  - `WTS_CONSOLE_CONNECT` i `DISCONNECT` (szybkie przełączanie użytkowników);
  - `WTS_SESSION_LOGOFF` [źródło].

  Zastosowanie: przy blokadzie lub rozłączeniu zapamiętujemy w pamięci początek nieobecności; przy odblokowaniu lub połączeniu ustalamy moment powrotu. Nic z tego nie trafia do bazy poza samym okresem.
- **Pulpit zdalny do tej samej sesji:** wejście przez RDP liczy się jako wejście tej sesji (API jest per sesja). Rozłączenie RDP bez wylogowania oznacza brak wejścia, więc bezczynność rośnie naturalnie.
- **Przełączenie na innego użytkownika Windows:** sesja TrackerMaster nie dostaje wejścia, więc bezczynność rośnie. Drugi użytkownik ma własny profil i własną bazę (PTT-26).
- **Wylogowanie, zamknięcie systemu, awaria:**
  - proces kończy się z działającym timerem;
  - otwarty okres bezczynności (§1.3) zostaje w bazie;
  - przy następnym starcie obowiązuje ścieżka odzyskiwania z #50: wpis „odzyskany”, użytkownik podaje koniec, a `resolve_recovered` przez `close_open_at_entry_end` przycina okres do końca wpisu i zostawia go jako pending [kod: `main.rs:1062-1067`]. Warunek: schemat dopuszcza `manual_resume=1` dla `idle` (§3.1, B3);
  - nie dodajemy obsługi `WM_ENDSESSION` z zapisem, bo zapis przy zamykaniu systemu jest zawodny.
- **Hibernacja:** to ścieżka uśpienia (`PBT_APMSUSPEND`), jak dziś.

### 1.7 Wymagane zmiany w istniejących ścieżkach uśpienia (wynik recenzji B1–B3)

Wspólna tabela (§3.1) **nie** działa „bez nowego kodu”. Obecny kod traktuje każdy wiersz `sleep_periods` jako sen. Poniższe zmiany są warunkiem pierwszego zapisu `idle` i wchodzą **w PR 1 razem ze schematem v15**, żeby v15 nigdy nie istniał bez nich (§6).

| Miejsce [kod, `de9091e`] | Dziś | Wymagane |
|---|---|---|
| `power_events.rs:74-79` `known_sleep` i `:82-88` `handle_suspend` | sumuje długości **wszystkich** okresów wpisu i porównuje z `total − awake` (tolerancja 4 s); przy otwartym okresie zwraca błąd „Nierozstrzygnięty koniec uśpienia”; przy różnicy sen **nie jest zapisany** | najpierw zamknąć otwarty `idle` na `t_suspend`; sumować tylko `source='sleep'` |
| `power_events.rs:91-100` `handle_resume`, w tym `:93` | bierze pierwszy otwarty okres **dowolnego** rodzaju jako „otwarty sen”; `previous` sumuje wszystkie zakończone okresy | szukać otwartego okresu tylko `source='sleep'`; `previous` tylko z `sleep` |
| `main.rs:213-246` `active_projection`, suma w `:228-235` | `known` z wszystkich okresów vs `total − awake`; przy różnicy `None` → Stop i przełączenie odmawiają, a pomiar trafia do odzyskiwania | `known` tylko z `sleep`; odejmowanie czasu pracy (`completed_periods`) nadal z obu rodzajów |
| `main.rs:893-897` `keeps_clock_for_open_sleep` | dowolny otwarty okres → „uzupełnij czas wybudzenia” | tylko otwarty `sleep`; otwarty `idle` nie może prowadzić do prośby o czas wybudzenia |
| `optional_task_migration.rs:39-48` `transition` (Stop, przełączenie, wznowienie) | projekcja przez `completed_periods`, która odrzuca otwarty okres (`sleep_periods.rs:247`) | w tej samej transakcji najpierw zamknąć otwarty `idle` na chwilę akcji (§1.4) |
| `sleep_periods.rs:139-152` `record_resume_manual` | pozwala wpisać koniec dowolnego otwartego okresu | tylko `source='sleep'`; bezczynności użytkownik nie kończy wpisaniem godziny |
| `sleep_periods.rs:159-165` `close_open_at_entry_end` | ustawia `manual_resume=1` | bez zmian; schemat musi to dopuszczać dla `idle` (§3.1) |
| `sleep_periods.rs:124-135` `record_resume` | `auto_included` tylko według długości | warunek O5 (§1.5) |

**Skutek bez tych zmian (dlaczego to blokery):** uśpienie po bezczynności (I07) nie zostałoby zapisane, Stop zostałby odrzucony, a w odzyskiwaniu `resolve_recovered` odejmuje tylko zapisane okresy [kod: `main.rs:1048-1070`]. Niezarejestrowany sen zostałby więc policzony jako praca, jeśli użytkownik poda rzeczywisty koniec.

---

## 2. Przypomnienia

### 2.1 „Nic nie mierzysz” w godzinach pracy

- **Warunki (wszystkie naraz):**
  - przypomnienia włączone;
  - żaden timer nie działa (AC3);
  - jest dzień i godzina z ustawionych godzin pracy;
  - **użytkownik jest obecny**, tzn. ostatnie wejście < 1 min temu, sprawdzone jednorazowo w pamięci, bez zapisu;
  - od ostatniego przypomnienia minął interwał.
- **Obecność:** bez warunku obecności przypomnienie pojawiałoby się przy pustym biurku.
- **Domyślnie** [zatwierdzone 25.11.2026, O3]:
  - pon.–pt. 9:00–17:00;
  - pierwsze przypomnienie po 15 min obecności bez timera;
  - potem najwyżej co 30 min;
  - przy pustym timerze w godzinach pracy.
- **Strefa czasowa:**
  - godziny pracy liczymy w strefie `reportTimezone` (D12, domyślnie Europe/Warsaw), żeby zmiana strefy Windows nie przesuwała przypomnień inaczej niż raporty;
  - dzień DST ma 23 lub 25 h, a godziny pracy są lokalnymi wskazaniami zegara;
  - przypomnienie przy godzinie „nieistniejącej” (zmiana czasu) przesuwa się na pierwszą istniejącą minutę.
- **Treść:** „Nic nie mierzysz. Uruchom timer, jeśli pracujesz.” Akcje: „Start” (otwiera wybór projektu; nie startuje po cichu ostatniego projektu) i „Wycisz na dziś”.

### 2.2 „Timer działa za długo”

- **Warunek:** jeden wpis działa nieprzerwanie dłużej niż próg.
  - Domyślnie **4 h** [zatwierdzone 25.11.2026, O4].
  - Liczymy czas ścienny od startu wpisu, a nie czas potwierdzony; chodzi o zapomniany timer.
- **Częstotliwość:** jedno przypomnienie na wpis po przekroczeniu progu i drugie po 2× progu. Bez kolejnych, żeby nie zasypywać użytkownika.
- **Treść:** „Timer działa od 4 h 05 min.” Akcje: „Zatrzymaj teraz”, „Działa dalej” (wycisza dla tego wpisu) i „Otwórz”.
  - Zatrzymanie z powiadomienia używa tej samej komendy co przycisk Stop (`expected_active_id`), więc nie zatrzyma innego, nowszego wpisu.
- **Gdy otwarty jest okres bezczynności:** to przypomnienie nie jest potrzebne, bo zastępuje je komunikat o bezczynności.

### 2.3 Kanały: najpierw w aplikacji, potem Windows

- **Kanał podstawowy: baner w aplikacji.** Pojawia się w oknie głównym i w widżecie, nieblokujący, w stylu banera D12-A.
  - Zawsze działa, także gdy powiadomienia Windows są wyłączone, przy Focus Assist / „Nie przeszkadzać” i w buildzie bez tożsamości aplikacji.
  - Baner bezczynności jest obowiązkowy. Powiadomienie Windows jest dodatkiem.
- **Powiadomienie Windows:** oficjalny `tauri-plugin-notification` (Tauri 2) [źródło].
  - **Instalacja:** crate `tauri-plugin-notification` i `.plugin(tauri_plugin_notification::init())`. Pakiet JS `@tauri-apps/plugin-notification` **nie jest potrzebny**, bo powiadomienia wysyła Rust.
  - **Uprawnienia:** zestaw `notification:default` daje oknom JS m.in. `notify`, `request-permission` i rejestrowanie akcji [źródło]. Rekomendacja: **nie dodawać** go do `capabilities/desktop.json`, bo JS nie musi móc wysyłać powiadomień. Mniejsza powierzchnia zgodna z PTT-26. Zdarzenia z kliknięć przekazuje Rust do UI istniejącym kanałem zdarzeń.
  - Na desktopie `request_permission` i `permission_state` zawsze zwracają „Granted” bez pytania [źródło: desktop.rs]. Faktyczne wyłączenie powiadomień przez użytkownika odbywa się w Ustawieniach Windows i aplikacja się o nim nie dowie. Dlatego baner w aplikacji jest obowiązkowy.
  - **Windows i tożsamość:**
    - wtyczka wysyła powiadomienie przez `notify-rust` z `app_id` = `identifier` z konfiguracji Tauri, a w buildzie spod `target\debug|release` app_id nie jest ustawiane [źródło: desktop.rs];
    - dokumentacja: „działa tylko dla zainstalowanych aplikacji; w trybie deweloperskim pokazuje nazwę i ikonę PowerShell” [źródło];
    - nasz niespakowany `tracker-master.exe` z artefaktu CI nie ma zarejestrowanego AppUserModelID, więc powiadomienie może nie pojawić się wcale **[do potwierdzenia, BLOCKED]**;
    - w MSIX (D11) tożsamość pochodzi z pakietu. **[do potwierdzenia, BLOCKED]** czy `app_id = pl.tracker.personal(.testonly)` przekazane przez wtyczkę zgadza się z AUMID pakietu (`<PFN>!App`) i czy powiadomienie się wyświetli. Jeśli nie, trzeba ustawić właściwy AUMID; to decyzja implementacyjna DEV-39 po teście.
  - **Przyciski w powiadomieniu:**
    - changelog wtyczki 2.6.0 podaje „Report actions on desktop”, a strona wtyczki nadal oznacza akcje jako „Mobile Only” [źródło] — sprzeczność **[do potwierdzenia]**;
    - na Windows kliknięcie jest raportowane tylko wtedy, gdy powiadomienie jest na ekranie, a nie po przeniesieniu do Centrum akcji [źródło: desktop.rs].
    - **Wniosek:** akcje decyzyjne (Dolicz / Odrzuć / Zatrzymaj) wykonujemy **wyłącznie w aplikacji**. Kliknięcie powiadomienia tylko otwiera okno z banerem. Dzięki temu decyzja o czasie nigdy nie zależy od działania powiadomień.
  - **MSIX:**
    - do samego wyświetlania powiadomień z działającej aplikacji nie przewidujemy dodatkowych wpisów w manifeście;
    - aktywacji po kliknięciu przy zamkniętej aplikacji (aktywator COM w manifeście) **nie** planujemy: aplikacja i tak działa w tle, gdy timer działa;
    - wpływ na `unvirtualizedResources` (D11) — brak.
    - To jest **[do potwierdzenia]** na rzeczywistym pakiecie.
  - **Zależności:** nowe crate'y (`tauri-plugin-notification`, `notify-rust` i zależności WinRT) zmieniają `Cargo.lock`. Wymagają przeglądu licencji i rozmiaru oraz builda `--locked` w CI.
- **Treść powiadomień bez nazw klientów, projektów i opisów.** Powiadomienia Windows mogą być widoczne na ekranie blokady i w Centrum akcji. Zasada jest taka sama jak przy banerze D12 („baner nie musi ujawniać nazw klientów”).

### 2.4 Ustawienia, zapis i wyłączanie

- **Sekcja ustawień** obok skrótu globalnego (`ShortcutSettings`) zawiera:
  - **Bezczynność:** włączona/wyłączona, próg (§1.2);
  - **Przypomnienie „nic nie mierzysz”:** włączone/wyłączone, dni tygodnia, godzina od–do, interwał;
  - **Przypomnienie „timer działa za długo”:** włączone/wyłączone, próg;
  - **Powiadomienia Windows:** włączone/wyłączone. Po wyłączeniu zostaje tylko baner w aplikacji.
- **Zapis:**
  - jeden plik JSON w katalogu danych aplikacji (np. `attention-settings.json`), zapisywany atomowo istniejącym `save_preference` (plik tymczasowy, `sync_all`, `rename`), jak zakres raportu i przypięcie widżetu [kod: `ui_preferences.rs`];
  - backend waliduje wartości (lista dozwolonych progów, `HH:MM`, od < do, co najmniej jeden dzień);
  - **brak pliku** oznacza domyślne wartości;
  - **plik uszkodzony** oznacza domyślne wartości i komunikat „Nie udało się odczytać ustawień przypomnień, przywrócono domyślne”. Nie wolno wtedy po cichu wyłączyć wykrywania bezczynności.
  - **Dlaczego nie SQLite:** ustawienia nie są danymi rozliczeniowymi, a plik nie wymaga migracji schematu.
  - **Ryzyko:** kopia bazy (backup/restore) nie obejmuje tego pliku, tak jak dziś pozostałych preferencji. Do odnotowania w R02 jako ustawienie poza bazą.
- **Wyłączanie:**
  - każde przypomnienie z osobna oraz bezczynność;
  - „Wycisz na dziś” z banera lub powiadomienia działa tylko w pamięci, do północy w `reportTimezone` albo do restartu, bez zapisu.
  - Wyłączenie bezczynności nie zmienia istniejących okresów: pending zostają do decyzji.
- **Stan przypomnień** (kiedy ostatnio, wyciszenie) **nie jest zapisywany** (AC4). Po restarcie liczy się od nowa.

---

## 3. Model danych i migracja

### 3.1 Rekomendacja: jedna tabela odcinków ze źródłem (schemat v15)

- **Zmiana:** rozszerzyć `sleep_periods` o kolumnę `source TEXT NOT NULL DEFAULT 'sleep' CHECK (source IN ('sleep','idle'))`. Migracja v15 przebudowuje tabelę z wierną kopią wierszy, tak jak v14 [kod: `sleep_periods_v14_migration.sql`]:
  - po zweryfikowanej kopii zapasowej;
  - w jednej transakcji;
  - z walidatorem schematu.
- **Co daje sam schemat:**
  - istniejące triggery dają **jeden zakaz nakładania dla obu rodzajów** w obrębie wpisu: `sleep_periods_no_overlap_insert/update` [kod: `sleep_periods_v14.sql:30-45`];
  - `sleep_periods_one_open`: najwyżej jeden otwarty odcinek na wpis [kod: `sleep_periods_v14.sql:21`], więc bezczynność musi być zamknięta przed otwarciem snu — dokładnie reguła z §1.5;
  - niezmienność granic i decyzji, zakaz usuwania (audyt), pending przy wstawieniu.
- **Co wymaga zmian w kodzie (§1.7):** kontrole zegara uśpienia, wyszukanie otwartego snu, `keeps_clock_for_open_sleep`, `record_resume_manual` i `transition` muszą rozróżniać `source`. Bez zmian, poza przyjęciem obu rodzajów, mogą zostać tylko odejmowanie czasu pracy (`periods_within_entry`, `completed_periods`, `counts_as_work`), lista pending, baner D12-A i wykluczenie z CSV.
- **Ograniczenia w CHECK:**
  - `auto_included` tylko dla `source='sleep'`;
  - `manual_resume = 1` **dozwolone także dla `idle`**, ale tylko w znaczeniu „koniec ustalony przy odzyskiwaniu wpisu”. Ustawia je `close_open_at_entry_end` [kod: `sleep_periods.rs:162`], a zakaz w CHECK przerwałby transakcję `resolve_recovered` przy każdym wpisie z otwartą bezczynnością i aplikacja utknęłaby w trybie odzyskiwania. Ręczne wpisanie końca bezczynności blokuje kod, nie schemat: `record_resume_manual` przyjmuje tylko `source='sleep'` (§1.7).
  - Walidator `validate_schema` [kod: `sleep_periods.rs:48-62`] dostaje te same warunki dla `source`.
- **Nazwa tabeli zostaje** (zmiana nazwy to szersza migracja bez zysku). W kodzie i UI wprowadzamy pojęcie „okres do rozstrzygnięcia” z polem `source`, a teksty rozróżniają „Uśpienie” i „Bezczynność”.
- **Alternatywa odrzucona:** osobna tabela `idle_periods` z triggerami sprawdzającymi nakładanie w obie strony. Podwaja walidatory, projekcje i listy, a łatwiej w niej o podwójne liczenie (AC2).

### 3.2 Co zapisujemy (minimum)

- Dla okresu bezczynności ≥ progu: `entry_id`, `started_ms`, `ended_ms`, `source='idle'`, `decision`, `decided_ms`. **Nic więcej.**
- Bezczynność poniżej progu, próbki `dwTime`, zdarzenia sesji, stan przypomnień i ustawienia przypomnień **nie trafiają do bazy**. Ustawienia są w pliku ustawień, bez historii.
- Zgodne z AC4: o aktywności zapisujemy tylko „od kiedy do kiedy nie było wejścia powyżej progu” i decyzję.

### 3.3 Wpływ na D3, D12 i odzyskiwanie

- **D3:** zasada bez zmian (najwyżej jeden aktywny timer, przełączenie w jednej transakcji). Transakcja przełączenia dostaje jeden krok na początku: zamknięcie otwartego `idle` wpisu A na chwilę przełączenia (§1.4, §1.7). Dziś Stop i przełączenie nie domykają otwartych okresów; robi to tylko `resolve_recovered` [kod: `main.rs:1064`]. Odcinki należą zawsze do jednego wpisu.
- **D12:**
  - pending bezczynności podlega tym samym regułom co pending snu: osobne pozycje, „Później”, baner przy starcie, brak akcji zbiorczych, poza potwierdzonymi sumami, finalne CSV tylko po rozstrzygnięciu;
  - baner przy starcie liczy oba rodzaje, np. „2 okresy do rozstrzygnięcia — 1 h 05 min”, z rozbiciem na liście;
  - raport „aktywne/projekcja” bez zmian, z jednym dopowiedzeniem: otwarty okres bezczynności wyłącza z projekcji odcinek od swojego początku do teraz (§1.3).
- **Odzyskiwanie (#50):** otwarty okres bezczynności po awarii jest przycinany do podanego końca wpisu (`manual_resume=1`, dozwolone dla `idle` według §3.1) i zostaje pending, tak jak otwarte uśpienie. Test I06 przechodzi przez `resolve_recovered`, a nie tylko przez funkcję modułu.
- **Kopia i przywracanie:** okresy są w bazie, więc wchodzą do kopii. Walidator schematu v15 musi odrzucić kopię z nieznanym `source`.
- **Migracja:**
  - v14 → v15 tylko dodaje kolumnę z domyślnym `sleep`;
  - stare wiersze mają te same wartości;
  - test migracji: wszystkie wiersze, decyzje i sumy identyczne przed i po; odmowa przy uszkodzonej tabeli v14, jak test v14.
  - Przy tej przebudowie pamiętać o wolnych stronach po przebudowie (przypadek testu `SQLITE_FULL` z #62).

---

## 4. Prywatność (PTT-26) i bezpieczeństwo

- **Zakres danych:** wyłącznie znacznik czasu ostatniego wejścia, w pamięci, i okresy ≥ progu, w lokalnej bazie użytkownika. Bez treści, okien, aplikacji, adresów, zrzutów i statystyk aktywności. Brak wysyłki: aplikacja jest lokalna (D1), bez telemetrii.
- **Brak hooków systemowych:** żadnych globalnych hooków wejścia ani Raw Input. `GetLastInputInfo` zwraca dane tylko dla sesji, która wywołała funkcję [źródło], więc nie daje dostępu do innych sesji. Brak wymagań co do uprawnień jest **[do potwierdzenia]**: strona MS mówi wprost tylko o zakresie sesji.
- **Logi:** nie logujemy wartości `dwTime`, początków nieobecności ani treści przypomnień. Błędy są ogólne („Nie udało się odczytać czasu ostatniej aktywności”).
- **Powiadomienia:**
  - bez nazw klientów, projektów i opisów (ekran blokady, Centrum akcji);
  - JS nie dostaje uprawnienia `notification:*` (§2.3);
  - akcje z powiadomienia nie zapisują decyzji o czasie, tylko otwierają aplikację; „Zatrzymaj” używa `expected_active_id`.
- **Odporność na zegar:** zmiana zegara ściennego w trakcie nieobecności kończy się istniejącą ochroną „niepewny pomiar”, nie cichym zapisem.
- **FFI:**
  - jedno wywołanie `GetLastInputInfo` z `cbSize = size_of::<LASTINPUTINFO>()`;
  - nowe cechy `windows-sys` (dziś `Cargo.toml:20` ma tylko `Win32_Security`, `Win32_System_Threading` i `Win32_UI_WindowsAndMessaging` [kod]): `Win32_UI_Input_KeyboardAndMouse` (`GetLastInputInfo`), `Win32_System_SystemInformation` (`GetTickCount`), a w PR 5 `Win32_System_RemoteDesktop` (WTS). Dokładne nazwy cech dla `windows-sys` 0.61 są **[do potwierdzenia]** przy implementacji;
  - okno komunikatów WTS w osobnym wątku, z wyrejestrowaniem przed zniszczeniem okna [źródło];
  - callbacki bez paniki przez granicę systemu (`catch_unwind`, `try_lock`), jak `power_events`.
- **Profil danych:** testy i E2E wyłącznie na `pl.tracker.personal.testonly` z danymi syntetycznymi. Profil `pl.tracker.personal` nie jest dotykany.
- **Ryzyko, które zostaje:** okresy bezczynności mówią, kiedy użytkownika nie było przy komputerze. To dane osobiste w lokalnej bazie i kopiach; kopie nie są domyślnie szyfrowane (T15). Do odnotowania w T15.

---

## 5. Scenariusze testowe

### 5.1 Deterministyczne w CI (Windows runner, bez prawdziwego wejścia)

- **Projekt testowalności:**
  - logika jest czystą maszyną stanów w Rust, np. `attention::step(state, sample, settings) -> actions`;
  - wejście przez trait, np. `InputClock { now_utc_ms, tick_ms (u32), last_input_tick (u32) }`, oraz zdarzenia `suspend`, `resume`, `lock`, `unlock`;
  - implementacja Windows jest cienką warstwą FFI;
  - testy Rust podają sztuczne próbki;
  - modele UI (teksty, liczby mnogie, harmonogram przypomnień w strefie IANA) mają testy node jak `sleepTime.test.ts` i `plural.ts`.
- **Bez furtek w produkcji:** testowe źródło wejścia nie może istnieć w buildzie produkcyjnym. Wstrzykiwanie tylko w testach `cargo test` albo w buildzie `testonly` (znacznik `TRACKERMASTER_BUILD_PROFILE`, #69). E2E sprawdza zapis i UI jak faza `short-sleep`, przez dane w bazie testonly, a nie przez fałszywe wejście.

| ID | Scenariusz | Oczekiwane |
|---|---|---|
| I01 | Bezczynność próg − 1 ms, potem wejście | brak wiersza; czas = praca |
| I02 | Bezczynność = próg (granica włącznie) | jeden wiersz `idle` pending od ostatniego wejścia |
| I03 | AC1: timer 30 min, 15 min bez wejścia, powrót | okres 15 min pending, komunikat; licznik bez tych 15 min |
| I04 | Dolicz / Odrzuć / Zatrzymaj o początku / Później | sumy wpisu, raport, CSV zgodne; ponowne kliknięcie i restart nie zmieniają wyniku |
| I05 | Później + restart | baner przy starcie liczy okres; lista pokazuje „Bezczynność” |
| I06 | Awaria przy otwartym okresie → odzyskiwanie **przez `resolve_recovered`** (nie tylko funkcję modułu) z końcem wpisu | transakcja się udaje (`manual_resume=1` dla `idle` dozwolone); okres przycięty do końca, pending; brak cichego doliczenia; aplikacja wychodzi z trybu odzyskiwania |
| I07 | Bezczynność 12 min, potem uśpienie 1 h: `handle_suspend` i `handle_resume` ze **spójną próbką zasilania** (`total − awake` = 1 h) przy istniejącym okresie `idle` | sen zapisany i zakończony; `active_projection` nie jest „niepewna”; dwa odcinki stykające się w `t_suspend`, bez nakładania i luki; suma = praca + 12 min pending + 1 h pending |
| I07b | Jak I07, ale zakończony okres `idle` sprzed snu i drugi okres `idle` po wybudzeniu | `handle_resume` znajduje otwarty `sleep`, nie `idle`; `previous` liczy tylko `sleep` |
| I07c | Otwarty `idle` i rozjechany zegar | `keeps_clock_for_open_sleep` = false: brak prośby o „czas wybudzenia” dla bezczynności |
| I08 | Krótki sen < 5 min przy otwartym okresie bezczynności (O5): okres `idle` z `ended_ms = started_ms` snu | sen pending, nie `auto_included`; także po restarcie między uśpieniem a wybudzeniem |
| I09 | Krótki sen < 5 min przed przekroczeniem progu | sen `auto_included` jak w #62; po cichu doliczone ≤ próg |
| I10 | Wybudzenie bez wejścia (zmiana `dwTime` = brak) | nieobecność liczona od wejścia sprzed snu; nowy okres zaczyna się ≥ `t_resume` |
| I11 | Trigger: próba wstawienia nakładającego się okresu `idle` na `sleep` (i odwrotnie) | `overlapping sleep periods` |
| I12 | CHECK: `auto_included` dla `idle`; `record_resume_manual` dla `idle` | oba odrzucone; `manual_resume=1` dla `idle` z `close_open_at_entry_end` przyjęte |
| I12b | Początek bezczynności sprzed startu wpisu albo sprzed końca poprzedniego okresu | przycięty według §1.3; poniżej progu po przycięciu → brak okresu |
| I13 | Licznik ticków: `dwTime` blisko `u32::MAX`, teraz po przekręceniu | poprawna bezczynność; wartość „z przyszłości” = 0 |
| I14 | Zmiana zegara ściennego w trakcie | „niepewny pomiar”, brak zapisu okresu z błędnymi granicami |
| I15 | D3: przełączenie A→B przy pending okresie A | okres zostaje przy A; B bez okresów |
| I15b | Powrót i od razu Stop, przełączenie albo wznowienie (< 15 s, okres `idle` jeszcze otwarty) | ta sama transakcja zamyka `idle` na chwilę akcji jako pending, potem kończy wpis; brak odmowy i brak komunikatu o „czasie wybudzenia” |
| I15c | „Zatrzymaj o początku bezczynności” (nowa komenda) | koniec wpisu = `started_ms` okresu; okres pending poza wpisem, niewidoczny na liście i w banerze; sumy bez okresu; `expected_active_id` innego wpisu odmawia |
| I16 | Blokada/odblokowanie, rozłączenie i połączenie (sztuczne zdarzenia) | granice zgodne z §1.6; brak zapisu zdarzeń sesji |
| I17 | Migracja v14→v15 | wszystkie wiersze z `source='sleep'`, identyczne sumy; odmowa dla uszkodzonego v14; wolne strony = 0 po VACUUM |
| I18 | AC3: przypomnienie przy działającym timerze, poza godzinami, w dniu wolnym, przy wyłączonym | brak przypomnienia |
| I19 | Przypomnienie w godzinach, użytkownik obecny / nieobecny | jedno przypomnienie po 15 min obecności; brak przy nieobecności; najwyżej co 30 min |
| I20 | Godziny pracy w dniu zmiany czasu (Europe/Warsaw, 23 h i 25 h) | przypomnienia według lokalnych godzin `reportTimezone` |
| I21 | „Timer działa za długo” | jedno po progu, drugie po 2× progu, nic więcej; „Zatrzymaj” z `expected_active_id` innego wpisu odmawia |
| I22 | Plik ustawień: brak / uszkodzony / niedozwolona wartość | domyślne; komunikat; bez wyłączenia bezczynności |
| I23 | AC4: schemat i zawartość bazy po pełnym scenariuszu | jedyne nowe dane to okresy ≥ progu z decyzją; brak innych tabel i kolumn |
| I24 | Brak kanału Windows (powiadomienie się nie udało) | baner w aplikacji nadal jest; brak błędu blokującego |
| I25 | Prywatność kodu: lista importów Win32 | brak `SetWindowsHookEx`, `GetForegroundWindow`, `GetWindowText`, `RegisterRawInputDevices` |
| E2E | Faza w `tests/windows-application.mjs` (testonly): zapis okresów `idle` i `sleep` do bazy w jednej transakcji (`openTestDb`, #70), odczyt listy, baner, Dolicz/Odrzuć, CSV | zgodne sumy; okresy bezczynności i uśpienia rozróżnione w UI |

### 5.2 Windows 11 x64 (fizycznie) — **BLOCKED** do wykonania, nie PASS

- **W1:** prawdziwa bezczynność 15 min przy timerze, potem powrót myszą → komunikat (AC1).
- **W2:** blokada Win+L i odejście; czy wpisanie PIN-u odświeża `GetLastInputInfo` (§1.6).
- **W3:** sesja RDP do tej samej sesji, rozłączenie, ponowne połączenie.
- **W4:** szybkie przełączanie użytkowników.
- **W5:** bezczynność, potem automatyczne uśpienie (Modern Standby lub S3) i wybudzenie klawiszem oraz otwarciem pokrywy; także krótki sen < 5 min (I07–I10 na sprzęcie).
- **W6:** powiadomienie Windows z niespakowanego EXE z artefaktu CI (oczekiwane: może się nie pojawić) i z pakietu MSIX testonly oraz Store (AUMID, ikona, nazwa).
- **W7:** Focus Assist / „Nie przeszkadzać”: powiadomienie wyciszone, baner w aplikacji widoczny.
- **W8:** powiadomienia wyłączone w Ustawieniach Windows: baner w aplikacji widoczny.
- **W9:** wylogowanie i zamknięcie systemu przy otwartym okresie, potem odzyskiwanie.
- **W10:** pełny dzień z godzinami pracy i przypomnieniami (wiersz runbooka w QA-MVP §7).

---

## 6. Rekomendowany podział PR (DEV-39)

| Kolejność | PR | Zakres | Ryzyko | Szacunek |
|---|---|---|---|---|
| 1 | **Schemat v15 + filtry `source`** | Kolumna `source`, migracja z kopią, walidator, CHECK dla `idle` (§3.1). **Wszystkie zmiany z §1.7**, żeby v15 nigdy nie istniał bez nich: filtry `source='sleep'` w kontrolach zegara, `handle_resume`, `keeps_clock_for_open_sleep`, `record_resume_manual`. Testy I07 (sztucznie wstawiony `idle`), I07b, I07c, I11, I12, I17 oraz I06 przez `resolve_recovered`. UI bez zmian. | **wysokie** (migracja danych, niezmienne triggery, test `SQLITE_FULL`, kontrole zegara) | M–L (2–3 dni) |
| 2 | **Silnik bezczynności + komunikat** | Trait źródła wejścia, maszyna stanów, `GetLastInputInfo`, zapis przy progu z przycięciem początku, zamknięcie przy powrocie, przy `suspend` i w `transition` (Stop, przełączenie, wznowienie), reguła O5 w `record_resume`, **nowa komenda „Zatrzymaj o początku bezczynności”**, licznik „Bezczynność od…”, baner z 4 akcjami, lista pending z rodzajem, ustawienie progu. Testy I01–I05, I08–I10, I12b, I13–I15c, I23, I25 oraz E2E. | **wysokie** (styk z D4/#62 i odzyskiwaniem) | L (3–4 dni) |
| 3 | **Przypomnienia w aplikacji** | „Nic nie mierzysz”, „Timer działa za długo”, ustawienia w pliku JSON, wyciszenie na dziś. **Z góry miejsce na przełącznik powiadomień Windows** w sekcji ustawień i w pliku JSON. Testy I18–I22. | średnie | M (1–2 dni) |
| 4 | **Powiadomienia Windows** | `tauri-plugin-notification` wywoływany z Rust, bez uprawnień JS, kliknięcie otwiera okno, przełącznik w miejscu przygotowanym w PR 3, zależności w `Cargo.lock`. Test I24. W6–W8 BLOCKED. | średnie (tożsamość MSIX, zależności) | S–M (0,5–1 dnia) |
| 5 | **Zdarzenia sesji (opcjonalny)** | Okno komunikatów WTS, blokada i RDP jako doprecyzowanie granic. Test I16. Robić **dopiero, gdy W2–W4 pokażą potrzebę.** | średnie (wątek, okno, wyrejestrowanie) | M (1–2 dni) |
| 6 | **QA** | Wiersze w `docs/QA-MVP-ACCEPTANCE-MATRIX.md`: nowe T dla PTT-61, dowody CI, runbook W1–W10. | niskie | S |

- **Kolejność:** 1 → 2 → 3 → 4 → 6, **po kolei**: PR 3 i 4 dotykają tej samej sekcji ustawień i tego samego pliku JSON. PR 5 według wyników Windows 11.
- **Każdy PR:**
  - dwa zielone przebiegi Windows CI na tym samym SHA;
  - nowe testy node w workflow;
  - bez osłabiania testów;
  - dane syntetyczne.
- PR 1 i 2 można złączyć, jeśli recenzent woli widzieć migrację razem z użyciem. Rekomendujemy osobno, bo migracja jest najbardziej ryzykowna i łatwiej ją wycofać.

---

## 7. Decyzje zatwierdzone 25.11.2026

Właściciel zatwierdził 25.11.2026 wszystkie rekomendacje O1–O9 bez zmian (przekazane przez koordynatora). Kolumna „Wybór” to wariant obowiązujący dla DEV-39.

| ID | Pytanie | Rozważane warianty | Wybór (zatwierdzony) |
|---|---|---|---|
| O1 | Próg i stan domyślny bezczynności | 5 / 10 / 15 min; domyślnie włączone lub wyłączone | **10 min, włączone**. Lista 5 / 10 / 15 / 30 / 60 min i „Wyłączone”. |
| O2 | Licznik w trakcie otwartej bezczynności | (a) zatrzymany na początku bezczynności z oznaczeniem; (b) rośnie dalej, a odrzucenie odejmuje | **(a)**: nic nierozstrzygniętego nie wygląda jak praca. Cofnięcie licznika przy przekroczeniu progu objaśnia oznaczenie (§1.3). |
| O3 | „Nic nie mierzysz”: godziny pracy i rytm | dni, godziny, pierwsze przypomnienie, interwał; domyślnie włączone lub wyłączone | **pon.–pt. 9:00–17:00 w `reportTimezone`, po 15 min obecności, najwyżej co 30 min, włączone**, tylko przy obecności użytkownika |
| O4 | „Timer działa za długo”: próg | 2 / 3 / 4 / 6 / 8 h | **4 h**, drugie po 8 h, potem cisza |
| O5 | Krótki sen < 5 min w trakcie otwartej bezczynności | (a) pending razem z bezczynnością; (b) bez zmian w #62 (auto) | **(a)**: wyjątek od reguły z #62 (23.11.2026) **tylko w tym przypadku**; warunek w §1.5. W każdym innym przypadku #62 bez zmian (I09). |
| O6 | Akcja „Zatrzymaj o początku bezczynności” | w komunikacie lub nie | **tak**, jako nowa komenda (§1.4, PR 2) |
| O7 | Powiadomienia Windows | (a) dodatek do banera, domyślnie włączone; (b) tylko baner w V1.1 | **(a), z zastrzeżeniem W6**: jeśli MSIX nie pokaże powiadomień poprawnie, V1.1 wychodzi z samym banerem. |
| O8 | Zdarzenia sesji (blokada, RDP) | od razu lub po wynikach W2–W4 | **po wynikach W2–W4**: v1 opiera się na `GetLastInputInfo` |
| O9 | Treść powiadomień | z nazwą projektu lub bez | **bez nazw** (ekran blokady); szczegóły dopiero w aplikacji |

---

## 8. Źródła

- **Notion (odczyt, bez zmian):**
  - PTT-61 i TECH-12 (zakres, AC1–AC4);
  - D3 (przełączanie zadania);
  - D4 (uśpienie, krótki sen 23.11);
  - D12 (pending, „Później”, baner przy starcie, uwaga o Toggl).
- **Repozytorium `main` @ `de9091e`** (linie podane przy twierdzeniach `[kod]`):
  - `src-tauri/src/sleep_periods.rs`, `sleep_periods_v14.sql`, `sleep_periods_v14_migration.sql`;
  - `power_events.rs` (`known_sleep`, `handle_suspend`, `handle_resume`);
  - `main.rs` (`active_projection`, `pending_sleep`, `keeps_clock_for_open_sleep`, `resolve_recovered`);
  - `optional_task_migration.rs` (`transition`);
  - `Cargo.toml` (cechy `windows-sys`);
  - `ui_preferences.rs`;
  - `capabilities/desktop.json`;
  - `docs/QA-MVP-ACCEPTANCE-MATRIX.md`.
- **Tauri:**
  - https://v2.tauri.app/plugin/notification/ — instalacja, uprawnienia, „działa tylko dla zainstalowanych aplikacji; w dev PowerShell”, akcje oznaczone jako mobile;
  - https://v2.tauri.app/release/notification/all-versions/ — 2.6.0 „Report actions on desktop”, 2.5.0 poprawka `isPermissionGranted` na Windows;
  - https://docs.rs/crate/tauri-plugin-notification/latest/source/src/desktop.rs — `notify-rust`, `app_id` = `identifier` poza `target\debug|release`, uprawnienie zawsze „Granted”, kliknięcie tylko przy widocznym powiadomieniu.
- **Microsoft:**
  - https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastinputinfo — dane per sesja; `dwTime` może być mniejsze od poprzedniego;
  - https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-lastinputinfo;
  - https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-gettickcount — przekręcenie po 49,7 dnia;
  - https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsregistersessionnotification;
  - https://learn.microsoft.com/en-us/windows/win32/termserv/wm-wtssession-change.
- **Toggl Track:** strony pomocy o idle detection i tracking reminders niedostępne (404) 24.11.2026. Szczegóły zachowania Toggl są **[do potwierdzenia]** i nie są podstawą rekomendacji.
