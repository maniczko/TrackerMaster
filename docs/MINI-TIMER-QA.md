# Mini timer — Quiet Precision

## Zakres PR i kontrakt

- Pasek 440 × 76 DIP: Start/Stop, zegar z cyframi tabularnymi (bez resetu po 24 h), zadanie i klient/projekt, pin, panel, zamknięcie. Przeciągnięcie przesuwa okno. Pełna nazwa jest w etykiecie dostępności i w rozwiniętym kontekście (Enter na nazwie); tytuł daje podgląd myszą.
- Panel 440 × 390 DIP: te same kontrolki, przewijana zawartość, maks. cztery unikalne ostatnie przypisania z historii, wyszukiwanie także bez polskich znaków, grupy klient/projekt i „Bez zadania”. Strzałki i Enter wybierają wynik; Tab przechodzi dalej, a Escape zwija panel i oddaje fokus kontrolce, która go otworzyła. W trakcie pomiaru można zmienić opis lub rozliczalność; nie ma możliwości zmiany przypisania aktywnego wpisu.
- `widget_project_start` wymaga braku aktywnego wpisu, a `widget_stop` weryfikuje oczekiwane ID. Sekundy i zapis pozostają po stronie natywnej. `get_snapshot` stosuje konserwatywną weryfikację zegarów: przy nierozstrzygniętym wyniku przechodzi w istniejący tryb odzyskiwania, nie dopisuje czasu i nie zamyka wiersza. Użyj „Rozstrzygnij czas”, aby otworzyć istniejący formularz w aplikacji. To nie jest obsługa wykluczania okresów uśpienia z PR #8.
- `set_entry_description` i `set_entry_billable` zmieniają metadane wskazanego ID po porównaniu wartości oczekiwanej, z historią zmian. Jeśli pełna aplikacja zakończy wpis w trakcie wywołania, istniejący kontrakt pozwala na zapis tylko tego samego wpisu, nie innego timera. Przy konflikcie opis pozostaje do ręcznej decyzji; po zmianie wpisu szkic pozostaje dostępny do skopiowania, bez automatycznego przypisywania.
- UI blokuje zduplikowane zapisy, ignoruje odczyty sprzed zapisu i nie ponawia niepotwierdzonych mutacji. Szkice zostają w otwartym oknie, także przy błędzie; celowe zamknięcie okna ich nie utrwala. `Ctrl+Shift+Spacja`, `tracker-shortcut` i WebView `widget-on-top` pozostają zgodne z `main`.

## Walidacja

- `node --test tests/miniTimer.test.ts`: stany i format zegara, pełny tekst kontekstu, wyszukiwanie i projekt bez zadania, klawisze listy, komendy według stanu, konflikt opisu, bramka zapisów i odczyt przypięcia.
- `npm run build` oraz `cargo test --locked --manifest-path src-tauri/Cargo.toml` w repozytorium z przypiętymi zależnościami. Zestaw Rust obejmuje test rozbieżności zegara/pomiaru, uśpienia i błędu odczytu.
- Próba Chromium: produkcyjny JSX i CSS na Vite z lokalnym React 19 i symulowanymi odpowiedziami Tauri. Obejmuje długie polskie nazwy, oba widoki, fokus, klawiaturę, zablokowany Stop po odzyskiwaniu, Start/Stop i duplikaty, aktywne edycje, zachowanie szkicu i przypięcie. Nie jest dowodem działania WebView2, SQLite ani Windows.

## Blokady wydania / wpis do backlogu

**Mini timer: odbiór Windows 11 WebView2 i geometria okna.** Na izolowanej bazie zweryfikować 100%, 125%, 150%, 200% DPI, duże czcionki, skalowanie UI, tryb wysokiego kontrastu, Narratora, pełną obsługę klawiaturą oraz przypięcie po ponownym otwarciu. Przetestować uśpienie i restart przed/po zapisie, rozstrzygnięcie czasu, skrót w aplikacji i poza nią, a także monitor dodatkowy o innej skali, ujemne współrzędne, pasek zadań i odłączenie monitora. Sprawdzić, czy informacja i przyciski mieszczą się bez nakładania. W razie potrzeby wydzielić kontrakt dla obszaru roboczego monitora, ograniczenia pozycji po przesunięciu/odłączeniu oraz trwałej szerokości. Ta zmiana zachowuje dotychczasową podstawową trwałość pozycji, ale nie dodaje regulacji szerokości ani gwarancji po zmianie topologii monitorów. Zmianę przypisania uruchomionego pomiaru i trwałość preferencji poza profilem WebView2 uzgodnić osobno; nie zakładać kontraktu z innych PR.
