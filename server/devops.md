# GardenAI Server: единый деплой в GCP Cloud Run

Скрипт [`deploy-gcp-cloudrun.sh`](./deploy-gcp-cloudrun.sh) делает полный деплой end-to-end:
- проверка `gcloud` авторизации и доступа к `PROJECT_ID`;
- включение нужных API;
- создание/обновление секретов в Secret Manager;
- создание Redis (Memorystore) и VPC connector (если не существуют);
- сборка контейнера в Artifact Registry;
- деплой в Cloud Run с нужными env/secrets.

## Быстрый запуск
```bash
cd /home/john/Documents/Work2026/GardenAi/server
./deploy-gcp-cloudrun.sh
```

По умолчанию используется проект `ticktoe-490714`.

## Откуда скрипт берет секреты
Приоритет:
1. переменные окружения shell;
2. файл `.env` в корне проекта;
3. если переменная не найдена, но секрет в GCP уже существует, скрипт использует существующий секрет;
4. если нет ни переменной, ни секрета — скрипт завершится с ошибкой.

Обязательные переменные/секреты:
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_REALTIME_DEPLOYMENT`
- `AZURE_OPENAI_VISION_DEPLOYMENT`

## Настройка через env (опционально)
```bash
PROJECT_ID=ticktoe-490714 \
REGION=us-central1 \
SERVICE_NAME=gardenai-server \
REDIS_INSTANCE=gardenai-redis \
VPC_CONNECTOR=gardenai-svpc \
SECRET_PREFIX=gardenai \
./deploy-gcp-cloudrun.sh
```

## Что еще добавлено в репозиторий
- `Dockerfile` для Cloud Run (`PORT=8080`, `npm ci --omit=dev`, `npm start`).
- `.dockerignore` чтобы не отправлять лишнее в build context.
 
