declare module "adm-zip" {
  interface AdmZipEntry {
    readonly entryName: string;
    readonly isDirectory: boolean;
    getData(): Buffer;
  }

  export default class AdmZip {
    constructor(path: string);
    getEntries(): AdmZipEntry[];
  }
}
