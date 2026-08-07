<p align="center">
  <img src="https://img.shields.io/badge/pi%20agent-web%20panel-005fb8?style=for-the-badge&labelColor=161616" alt="pi agent web panel" />
  <img src="https://img.shields.io/badge/stack-react%2019%20%2B%20TS%20strict-005fb8?style=for-the-badge&labelColor=161616" alt="React 19 + TypeScript strict" />
  <img src="https://img.shields.io/badge/design-Swiss%20%C3%97%20IBM-005fb8?style=for-the-badge&labelColor=161616" alt="Swiss × IBM design" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-005fb8?style=for-the-badge&labelColor=161616" alt="Apache-2.0" />
</p>
<div align="center">
<span style="font-weight:600;font-size:40px">PiHub</span><br/>
<span style="font-weight:300;font-size:22px">Где π связывает всё — Where π connects everything.</span>
<p align="center">
  <strong>Локальная веб-панель для pi coding agent.</strong><br/>
  <sub>потоковый чат · деревья сессий · модели и стоимость · расширения и навыки — в вашем браузере, на вашей машине</sub>
</p>
<p align="center">
  <a href="../README.md">English</a> · <a href="../README-CN.md">中文</a> · <strong><a href="README.ru-RU.md">Русский</a></strong>
</p>
</div>

## Что такое PiHub

PiHub — это браузерное рабочее пространство для [`pi`](https://pi.dev)
(`@earendil-works/pi-coding-agent`), которое полностью работает на вашем
компьютере. Оно общается с локальным процессом `pi --mode rpc` через
лёгкий Node-мост — без облака, без аккаунтов, данные не покидают вашу машину.

Это независимая реализация «с чистого листа» (clean-room) — написана
с нуля, чужой UI-исходник не используется.

## Возможности

### Чат
- Потоковая передача в реальном времени с режимами steer / interrupt и
  очередью follow-up
- Интерфейс рассуждений: состояния мышления с иконками, время выполнения,
  сворачивание рабочего процесса (`>`), опциональный режим упрощённого вывода
- Встроенный выбор модели и уровня мышления (применяется сразу)
- Настройка отправки: `Enter`, `⌘+Enter` или `Ctrl+Enter`
- Подсказки `/` для расширений, навыков и шаблонов подсказок
- Вставка изображений

### Сессии
- Список сессий с индикаторами состояния (завершено / выполняется / прервано)
- Коллекции (группы и проекты) с drag-and-drop и собственными именами
- Архивация (восстановимая в настройках) и защищённое удаление
- Контекстное меню: открыть · новая ветка (клон) · архивировать · удалить
- Фильтры дерева в деталях сессии: все / основная ветка / без инструментов /
  только пользователь
- Клавиатурная навигация: `⌘`/`Ctrl` + `↑`/`↓` для переключения сессий

### Модели и каналы
- Переключение модели и уровня мышления, цикл моделей (`Ctrl+Shift+L`)
- Редактор пользовательских API-каналов, записывающий
  `~/.pi/agent/models.json` (base URL, токен, тип API, контекстное окно,
  максимальный вывод, рассуждения, входные типы)
- Глобальная и посессионная статистика токенов и стоимости

### Настройки (семь разделов)
Общие · Персонализация · Модели и каналы · Управление сессиями ·
Разрешения · Избранные подсказки · Лаборатория

## Быстрый старт

Требуются [pi](https://pi.dev) (`pi --version` ≥ 0.83) и Node.js ≥ 20.

```bash
git clone <your-fork-or-local-root>/pi-panel
cd pi-panel
npm install
npm run dev        # веб-интерфейс: http://localhost:18384 (бэкенд 127.0.0.1:3001)
```

Продакшен-сборка:

```bash
npm run build      # typecheck + lint + сборка в dist/
npm test           # тесты схем и разбора сессий
```

Затем откройте **http://localhost:18384**. Панель слушает только
loopback-интерфейс.

## Горячие клавиши

| Клавиши | Действие |
| --- | --- |
| `Esc` | прервать выполняющегося агента |
| `Ctrl+Shift+M` | палитра автоматизации / навыков / процессов |
| `Ctrl+Shift+L` | цикл переключения модели |
| `⌘`/`Ctrl` + `↑`/`↓` | переключение сессии |
| `Alt+1..4` | чат / сессии / статистика / настройки |

## Структура

```
src/       React SPA (строгий TypeScript, ноль `any`)
server/    Node-бэкенд — RPC-мост pi, REST, SSE
shared/    Общие типы + zod-схемы границ
scripts/   Dev-запуск
public/    PWA manifest, иконка, service worker
```

## Границы

- **Только локально**: панель слушает только `127.0.0.1` / `localhost`.
- **Никогда не читает учётные данные**: `~/.pi/agent/auth.json` не
  читается и не раскрывается панелью.
- **Минимальная запись**: панель записывает только то, что вы просите —
  новые диалоги через RPC pi, пользовательские каналы в `models.json`
  и предпочтения панели в localStorage браузера.
- **Clean-room**: независимая реализация, написана с нуля.

## Лицензия

Apache License 2.0 — см. [LICENSE](LICENSE).

Сторонние ресурсы:
- [HarmonyOS Sans SC](src/assets/fonts/LICENSE-HarmonyOS-Sans.txt) —
  Huawei Device Co., Ltd. (встроенный шрифт, лицензия в файле)
- HM Symbols — подмножество из пакета `hm_symbol` на pub.dev
  (HarmonyOS Symbols; см. лицензию пакета)
- [IBM Plex](https://github.com/IBM/plex) — SIL Open Font License

## Документация

- [Manual (English)](../MANUAL.md)
- [README (English)](../README.md)
- [README 中文](README.zh-CN.md)
