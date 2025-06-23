/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BASIC_AUTH_USERNAME?: string;
  readonly VITE_BASIC_AUTH_PASSWORD?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
} 