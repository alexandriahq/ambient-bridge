export type AmbientToastActionTone = "primary" | "secondary" | "ghost";

export type AmbientToastAction = {
  readonly label: string;
  readonly tone?: AmbientToastActionTone;
  readonly onClick?: () => void | Promise<void>;
};

export type AmbientToastVariant = "info" | "success" | "warning" | "error" | "loading";
