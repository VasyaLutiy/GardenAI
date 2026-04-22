#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"

PROJECT_ID="${PROJECT_ID:-ticktoe-490714}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-gardenai-server}"
REPO_NAME="${REPO_NAME:-gardenai}"
IMAGE_NAME="${IMAGE_NAME:-server}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${IMAGE_NAME}:${IMAGE_TAG}"

SECRET_PREFIX="${SECRET_PREFIX:-gardenai}"
REDIS_INSTANCE="${REDIS_INSTANCE:-gardenai-redis}"
REDIS_TIER="${REDIS_TIER:-basic}"
REDIS_SIZE_GB="${REDIS_SIZE_GB:-1}"
REDIS_VERSION="${REDIS_VERSION:-redis_7_0}"
VPC_CONNECTOR="${VPC_CONNECTOR:-gardenai-svpc}"
VPC_NETWORK="${VPC_NETWORK:-default}"
VPC_CONNECTOR_RANGE="${VPC_CONNECTOR_RANGE:-10.8.0.0/28}"

ALLOW_UNAUTHENTICATED="${ALLOW_UNAUTHENTICATED:-true}"
CPU="${CPU:-1}"
MEMORY="${MEMORY:-512Mi}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"
MAX_INSTANCES="${MAX_INSTANCES:-10}"
CONCURRENCY="${CONCURRENCY:-80}"
TIMEOUT="${TIMEOUT:-300}"

RUNNER="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1 || true)"
if [[ -z "${RUNNER}" ]]; then
  echo "ERROR: Нет активной gcloud-сессии. Выполните: gcloud auth login"
  exit 1
fi

echo ">> Активный gcloud аккаунт: ${RUNNER}"
echo ">> Проверка доступа к проекту: ${PROJECT_ID}"
gcloud projects describe "${PROJECT_ID}" --format='value(projectId,lifecycleState)' >/dev/null

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
RUNTIME_SA="${RUNTIME_SA:-${PROJECT_NUMBER}-compute@developer.gserviceaccount.com}"

echo ">> Установка gcloud project"
gcloud config set project "${PROJECT_ID}" >/dev/null

echo ">> Включение необходимых API"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  redis.googleapis.com \
  vpcaccess.googleapis.com \
  --project="${PROJECT_ID}"

read_from_env_file() {
  local key="$1"
  if [[ ! -f "${ENV_FILE}" ]]; then
    return 0
  fi
  local raw
  raw="$(grep -E "^${key}=" "${ENV_FILE}" | tail -n1 | cut -d'=' -f2- || true)"
  raw="${raw%\"}"
  raw="${raw#\"}"
  raw="${raw%\'}"
  raw="${raw#\'}"
  printf '%s' "${raw}"
}

load_var() {
  local key="$1"
  if [[ -n "${!key:-}" ]]; then
    return 0
  fi
  local value
  value="$(read_from_env_file "${key}")"
  if [[ -n "${value}" ]]; then
    export "${key}=${value}"
  fi
}

upsert_secret_from_var() {
  local secret_name="$1"
  local var_name="$2"
  local value="${!var_name:-}"

  if [[ -z "${value}" ]]; then
    if gcloud secrets describe "${secret_name}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
      echo ">> Секрет ${secret_name} уже существует, значение оставляю без изменений"
      return 0
    fi
    echo "ERROR: Нет значения для ${var_name} и отсутствует секрет ${secret_name}"
    echo "Установите переменную ${var_name} в окружении или в ${ENV_FILE}"
    exit 1
  fi

  if gcloud secrets describe "${secret_name}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    printf '%s' "${value}" | gcloud secrets versions add "${secret_name}" \
      --data-file=- \
      --project="${PROJECT_ID}" >/dev/null
    echo ">> Обновлен секрет: ${secret_name}"
  else
    printf '%s' "${value}" | gcloud secrets create "${secret_name}" \
      --data-file=- \
      --replication-policy=automatic \
      --project="${PROJECT_ID}" >/dev/null
    echo ">> Создан секрет: ${secret_name}"
  fi
}

grant_secret_access() {
  local secret_name="$1"
  gcloud secrets add-iam-policy-binding "${secret_name}" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="${PROJECT_ID}" >/dev/null
}

load_var AZURE_OPENAI_ENDPOINT
load_var AZURE_OPENAI_API_KEY
load_var AZURE_OPENAI_REALTIME_DEPLOYMENT
load_var AZURE_OPENAI_VISION_DEPLOYMENT
load_var AZURE_OPENAI_API_VERSION
load_var CORS_ORIGIN
load_var MAX_UPLOAD_BYTES
load_var RETENTION_HOURS
load_var ANALYSIS_TIMEOUT_MS
load_var STORAGE_CLEANUP_INTERVAL_MS
load_var RATE_LIMIT_WINDOW_MS
load_var RATE_LIMIT_MAX
load_var WS_RATE_LIMIT_MAX
load_var LOG_REQUESTS
load_var LOG_LEVEL
load_var LOG_JSON
load_var INTENT_CAPTURE_CONFIDENCE_THRESHOLD
load_var INTENT_CAPTURE_COOLDOWN_SEC
load_var ANALYSIS_FAIL_FALLBACK_LIMIT

echo ">> Подготовка Secret Manager"
SECRET_ENDPOINT="${SECRET_PREFIX}-azure-openai-endpoint"
SECRET_API_KEY="${SECRET_PREFIX}-azure-openai-api-key"
SECRET_REALTIME_DEPLOYMENT="${SECRET_PREFIX}-azure-openai-realtime-deployment"
SECRET_VISION_DEPLOYMENT="${SECRET_PREFIX}-azure-openai-vision-deployment"

upsert_secret_from_var "${SECRET_ENDPOINT}" AZURE_OPENAI_ENDPOINT
upsert_secret_from_var "${SECRET_API_KEY}" AZURE_OPENAI_API_KEY
upsert_secret_from_var "${SECRET_REALTIME_DEPLOYMENT}" AZURE_OPENAI_REALTIME_DEPLOYMENT
upsert_secret_from_var "${SECRET_VISION_DEPLOYMENT}" AZURE_OPENAI_VISION_DEPLOYMENT

grant_secret_access "${SECRET_ENDPOINT}"
grant_secret_access "${SECRET_API_KEY}"
grant_secret_access "${SECRET_REALTIME_DEPLOYMENT}"
grant_secret_access "${SECRET_VISION_DEPLOYMENT}"

echo ">> Проверка/создание Artifact Registry: ${REPO_NAME}"
if ! gcloud artifacts repositories describe "${REPO_NAME}" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPO_NAME}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="GardenAI Docker images" \
    --project="${PROJECT_ID}" >/dev/null
fi

echo ">> Проверка/создание Redis instance: ${REDIS_INSTANCE}"
if ! gcloud redis instances describe "${REDIS_INSTANCE}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud redis instances create "${REDIS_INSTANCE}" \
    --region="${REGION}" \
    --tier="${REDIS_TIER}" \
    --size="${REDIS_SIZE_GB}" \
    --redis-version="${REDIS_VERSION}" \
    --project="${PROJECT_ID}" >/dev/null
fi

echo ">> Ожидание готовности Redis"
for _ in $(seq 1 60); do
  state="$(gcloud redis instances describe "${REDIS_INSTANCE}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(state)')"
  if [[ "${state}" == "READY" ]]; then
    break
  fi
  sleep 10
done

state="$(gcloud redis instances describe "${REDIS_INSTANCE}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(state)')"
if [[ "${state}" != "READY" ]]; then
  echo "ERROR: Redis не перешел в READY (текущее состояние: ${state})"
  exit 1
fi

REDIS_HOST="$(gcloud redis instances describe "${REDIS_INSTANCE}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(host)')"
REDIS_PORT="$(gcloud redis instances describe "${REDIS_INSTANCE}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(port)')"

echo ">> Проверка/создание VPC connector: ${VPC_CONNECTOR}"
if ! gcloud compute networks vpc-access connectors describe "${VPC_CONNECTOR}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute networks vpc-access connectors create "${VPC_CONNECTOR}" \
    --region="${REGION}" \
    --network="${VPC_NETWORK}" \
    --range="${VPC_CONNECTOR_RANGE}" \
    --project="${PROJECT_ID}" >/dev/null
fi

echo ">> Ожидание готовности VPC connector"
for _ in $(seq 1 60); do
  state="$(gcloud compute networks vpc-access connectors describe "${VPC_CONNECTOR}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(state)')"
  if [[ "${state}" == "READY" ]]; then
    break
  fi
  sleep 10
done

state="$(gcloud compute networks vpc-access connectors describe "${VPC_CONNECTOR}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(state)')"
if [[ "${state}" != "READY" ]]; then
  echo "ERROR: VPC connector не перешел в READY (текущее состояние: ${state})"
  exit 1
fi

echo ">> Cloud Build: ${IMAGE_URI}"
gcloud builds submit --tag "${IMAGE_URI}" --project="${PROJECT_ID}" "${ROOT_DIR}"

AZURE_OPENAI_API_VERSION="${AZURE_OPENAI_API_VERSION:-2024-10-21}"
MAX_UPLOAD_BYTES="${MAX_UPLOAD_BYTES:-8388608}"
RETENTION_HOURS="${RETENTION_HOURS:-24}"
ANALYSIS_TIMEOUT_MS="${ANALYSIS_TIMEOUT_MS:-25000}"
STORAGE_CLEANUP_INTERVAL_MS="${STORAGE_CLEANUP_INTERVAL_MS:-60000}"
RATE_LIMIT_WINDOW_MS="${RATE_LIMIT_WINDOW_MS:-60000}"
RATE_LIMIT_MAX="${RATE_LIMIT_MAX:-120}"
WS_RATE_LIMIT_MAX="${WS_RATE_LIMIT_MAX:-30}"
LOG_REQUESTS="${LOG_REQUESTS:-0}"
LOG_LEVEL="${LOG_LEVEL:-info}"
LOG_JSON="${LOG_JSON:-1}"
INTENT_CAPTURE_CONFIDENCE_THRESHOLD="${INTENT_CAPTURE_CONFIDENCE_THRESHOLD:-0.65}"
INTENT_CAPTURE_COOLDOWN_SEC="${INTENT_CAPTURE_COOLDOWN_SEC:-8}"
ANALYSIS_FAIL_FALLBACK_LIMIT="${ANALYSIS_FAIL_FALLBACK_LIMIT:-2}"

ENV_VARS=(
  "REDIS_URL=redis://${REDIS_HOST}:${REDIS_PORT}"
  "AZURE_OPENAI_API_VERSION=${AZURE_OPENAI_API_VERSION}"
  "MAX_UPLOAD_BYTES=${MAX_UPLOAD_BYTES}"
  "RETENTION_HOURS=${RETENTION_HOURS}"
  "ANALYSIS_TIMEOUT_MS=${ANALYSIS_TIMEOUT_MS}"
  "STORAGE_CLEANUP_INTERVAL_MS=${STORAGE_CLEANUP_INTERVAL_MS}"
  "RATE_LIMIT_WINDOW_MS=${RATE_LIMIT_WINDOW_MS}"
  "RATE_LIMIT_MAX=${RATE_LIMIT_MAX}"
  "WS_RATE_LIMIT_MAX=${WS_RATE_LIMIT_MAX}"
  "LOG_REQUESTS=${LOG_REQUESTS}"
  "LOG_LEVEL=${LOG_LEVEL}"
  "LOG_JSON=${LOG_JSON}"
  "INTENT_CAPTURE_CONFIDENCE_THRESHOLD=${INTENT_CAPTURE_CONFIDENCE_THRESHOLD}"
  "INTENT_CAPTURE_COOLDOWN_SEC=${INTENT_CAPTURE_COOLDOWN_SEC}"
  "ANALYSIS_FAIL_FALLBACK_LIMIT=${ANALYSIS_FAIL_FALLBACK_LIMIT}"
)

if [[ -n "${CORS_ORIGIN:-}" ]]; then
  ENV_VARS+=("CORS_ORIGIN=${CORS_ORIGIN}")
fi

ENV_STRING="$(IFS=,; echo "${ENV_VARS[*]}")"
AUTH_FLAG="--allow-unauthenticated"
if [[ "${ALLOW_UNAUTHENTICATED}" != "true" ]]; then
  AUTH_FLAG="--no-allow-unauthenticated"
fi

echo ">> Cloud Run deploy: ${SERVICE_NAME}"
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE_URI}" \
  --region "${REGION}" \
  --platform managed \
  "${AUTH_FLAG}" \
  --service-account "${RUNTIME_SA}" \
  --port 8080 \
  --cpu "${CPU}" \
  --memory "${MEMORY}" \
  --min-instances "${MIN_INSTANCES}" \
  --max-instances "${MAX_INSTANCES}" \
  --concurrency "${CONCURRENCY}" \
  --timeout "${TIMEOUT}" \
  --vpc-connector "${VPC_CONNECTOR}" \
  --vpc-egress private-ranges-only \
  --set-env-vars "${ENV_STRING}" \
  --set-secrets "AZURE_OPENAI_ENDPOINT=${SECRET_ENDPOINT}:latest,AZURE_OPENAI_API_KEY=${SECRET_API_KEY}:latest,AZURE_OPENAI_REALTIME_DEPLOYMENT=${SECRET_REALTIME_DEPLOYMENT}:latest,AZURE_OPENAI_VISION_DEPLOYMENT=${SECRET_VISION_DEPLOYMENT}:latest" \
  --project "${PROJECT_ID}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')"
echo ">> Deploy завершен"
echo ">> Service URL: ${SERVICE_URL}"
echo ">> Health check: ${SERVICE_URL}/healthz"
