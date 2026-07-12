export type Command = {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
};
