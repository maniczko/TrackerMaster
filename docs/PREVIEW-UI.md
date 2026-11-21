# Podgląd interfejsu w przeglądarce

Narzędzie do oceny wyglądu bez uruchamiania aplikacji Windows. Przydaje się, gdy niepodpisanych buildów nie da się uruchomić, np. przez Smart App Control.

```powershell
npm ci
npm run preview:ui
```

Następnie otwórz `http://127.0.0.1:1430/preview.html`. Strona pokazuje obok siebie mini widget (440×76, po rozwinięciu 440×390) i okno główne (1280×720), z przełącznikiem scenariuszy:

- **Pomiar w trakcie**
- **Brak pomiaru**
- **Do weryfikacji (po zamknięciu procesu)**
- **Niepewny czas po uśpieniu**

Skalę DPI 125% i 150% przybliża powiększenie przeglądarki (Ctrl +).

## Ograniczenia

- Backend jest udawany (`preview/mockCore.ts`): fikcyjne dane w pamięci, znikają po odświeżeniu.
- Akcje, których podgląd nie modeluje (archiwizacja, kopie, przywracanie, korekty, szkice itd.), kończą się komunikatem „Ta akcja nie jest dostępna w podglądzie interfejsu” zamiast fałszywego sukcesu.
- **Nie sprawdza** bazy SQLite, migracji, uśpienia i wybudzenia, skrótu globalnego, traya, okien Windows, WebView2 ani MSIX. Nie zastępuje odbioru na Windows 11 (UIQ-09, DEV-15, QA-01).
- Wygląd odpowiada Chromium/Edge, którego silnik ma też WebView2, ale fonty systemowe, skalowanie DPI i krawędzie okien mogą się różnić.

## Izolacja od aplikacji

Mocki są podpinane wyłącznie przez `vite.preview.config.ts`. Test `tests/previewIsolation.test.mjs` pilnuje, żeby:

- kod w `src/` nie importował mocków;
- `vite.config.ts` (build aplikacji) nie podmieniał API Tauri;
- konfiguracja podglądu podmieniała każdy moduł Tauri używany przez aplikację;
- zbudowany bundle nie zawierał kodu podglądu.
