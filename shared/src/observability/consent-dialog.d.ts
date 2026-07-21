export interface CrashConsentContent {
  /** Window/dialog headline, e.g. "Ambient quit unexpectedly". */
  readonly title: string;
  /** `Type: message` line shown in the error box. */
  readonly errorLabel: string;
  /** Locale-formatted crash timestamp. */
  readonly whenLabel: string;
  readonly origin: string;
  readonly errorCode: string | null;
  readonly dark: boolean;
  /** Custom URL scheme (e.g. "ambient-crash-report:") the buttons navigate to. */
  readonly eventScheme: string;
  readonly noteMaxLength: number;
}

export interface CrashReportConsent {
  readonly send: boolean;
  readonly includeLogs: boolean;
  readonly note: string;
}

export declare const CRASH_CONSENT_DECLINED: CrashReportConsent;

export declare function parseCrashConsentUrl(
  url: string,
  eventScheme: string,
  noteMaxLength: number,
): CrashReportConsent | null;

export declare function renderCrashConsentHtml(content: CrashConsentContent): string;
