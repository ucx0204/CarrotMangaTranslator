import type { MangaApi } from "../../shared/mangaApi";

declare global {
  interface Window {
    mangaApi: MangaApi;
  }
}

export {};
