<script lang="ts">
  import { Button, Icon, Pill, Select, SettingsShell, cn } from "@ambient/shared/design";
  import type { BridgeExperimentalBuildsSnapshot, BridgeUpdateStatus } from "../bridge-api";
  import bridgeIcon from "../../../resources/bridge-icon-source.png";

  type ExperimentalBuild = BridgeExperimentalBuildsSnapshot["builds"][number];

  type Props = {
    open?: boolean;
    appVersion: string;
    devtoolsEnabled: boolean;
    updateStatus: BridgeUpdateStatus;
    updateBusy: boolean;
    onCheckForUpdates: () => void | Promise<void>;
    onCheckForStableUpdates: () => void | Promise<void>;
    onInstallUpdate: () => void | Promise<void>;
    onListExperimentalBuilds: () => Promise<BridgeExperimentalBuildsSnapshot>;
    onInstallExperimentalBuild: (releaseKey: string) => void | Promise<void>;
  };

  let {
    open = $bindable(false),
    appVersion,
    devtoolsEnabled,
    updateStatus,
    updateBusy,
    onCheckForUpdates,
    onCheckForStableUpdates,
    onInstallUpdate,
    onListExperimentalBuilds,
    onInstallExperimentalBuild,
  }: Props = $props();

  const sections = $derived([
    { id: "about", label: "About" },
    ...(devtoolsEnabled ? [{ id: "dev", label: "Dev" }] : []),
  ]);
  let section = $state("about");
  let devPaneLoadRequested = $state(false);
  let experimentalBuilds = $state<BridgeExperimentalBuildsSnapshot | null>(null);
  let experimentalBuildsLoading = $state(false);
  let experimentalBuildsError = $state<string | null>(null);
  let selectedExperimentalBuildKey = $state("");
  let experimentalInstallBusy = $state(false);

  $effect(() => {
    if (!devtoolsEnabled && section === "dev") section = "about";
    if (!open || section !== "dev" || !devtoolsEnabled) {
      devPaneLoadRequested = false;
      return;
    }
    if (devPaneLoadRequested) return;
    devPaneLoadRequested = true;
    void refreshExperimentalBuilds();
  });

  function closeSettings(): void {
    open = false;
  }

  function updateLabel(): string {
    if (updateStatus.downloaded) return "Update ready";
    if (updateStatus.downloading) return "Downloading";
    if (updateStatus.checking || updateBusy) return "Checking";
    if (updateStatus.updateAvailable) return "Update available";
    if (!updateStatus.enabled) return "Updates off";
    return "Current";
  }

  function updateCheckDisabled(): boolean {
    return updateBusy || updateStatus.checking || updateStatus.downloading;
  }

  function checkForUpdates(): void {
    void onCheckForUpdates();
  }

  function installUpdate(): void {
    void onInstallUpdate();
  }

  async function refreshExperimentalBuilds(): Promise<void> {
    experimentalBuildsLoading = true;
    experimentalBuildsError = null;
    try {
      const snapshot = await onListExperimentalBuilds();
      experimentalBuilds = snapshot;
      const releaseKeys = snapshot.builds.map((build) => build.releaseKey);
      if (!selectedExperimentalBuildKey || !releaseKeys.includes(selectedExperimentalBuildKey)) {
        selectedExperimentalBuildKey = releaseKeys[0] ?? "";
      }
    } catch (cause) {
      experimentalBuildsError = errorMessage(cause, "Could not load experimental builds.");
    } finally {
      experimentalBuildsLoading = false;
    }
  }

  async function installSelectedExperimentalBuild(): Promise<void> {
    if (!selectedExperimentalBuildKey) {
      experimentalBuildsError = "Choose an experimental build first.";
      return;
    }
    experimentalInstallBusy = true;
    experimentalBuildsError = null;
    try {
      await onInstallExperimentalBuild(selectedExperimentalBuildKey);
    } catch (cause) {
      experimentalBuildsError = errorMessage(cause, "Could not start the experimental build installation.");
    } finally {
      experimentalInstallBusy = false;
    }
  }

  async function checkForStableUpdates(): Promise<void> {
    experimentalBuildsError = null;
    try {
      await onCheckForStableUpdates();
    } catch (cause) {
      experimentalBuildsError = errorMessage(cause, "Could not check the main release channel.");
    }
  }

  function experimentalBuildOptions(): readonly ExperimentalBuild[] {
    return experimentalBuilds?.builds ?? [];
  }

  function experimentalBuildSelectOptions(): readonly { value: string; label: string }[] {
    const builds = experimentalBuildOptions();
    if (builds.length === 0) return [{ value: "", label: "No builds available" }];
    return builds.map((build) => ({
      value: build.releaseKey,
      label: experimentalBuildOptionLabel(build),
    }));
  }

  function selectedExperimentalBuild(): ExperimentalBuild | null {
    return experimentalBuildOptions().find((build) => build.releaseKey === selectedExperimentalBuildKey) ?? null;
  }

  function experimentalBuildsTitle(): string {
    if (experimentalBuildsLoading) return "Loading experimental builds";
    if (experimentalBuildsError) return "Experimental build list failed";
    const count = experimentalBuildOptions().length;
    if (count === 0) return "No experimental builds found";
    return `${count} experimental build${count === 1 ? "" : "s"} available`;
  }

  function experimentalBuildsDetail(): string {
    if (experimentalBuildsError) return experimentalBuildsError;
    if (experimentalBuildsLoading) return "Reading published experimental release metadata.";
    const selected = selectedExperimentalBuild();
    if (selected) {
      return `${selected.version} · ${formatReleaseDate(selected.releasedAt)} · ${shortCommit(selected.commitSha)}${selected.notes ? ` · ${selected.notes}` : ""}`;
    }
    return experimentalBuilds?.releasesUrl ?? "Refresh to load experimental builds.";
  }

  function experimentalBuildOptionLabel(build: ExperimentalBuild): string {
    const label = [
      build.version,
      formatReleaseDate(build.releasedAt),
      shortCommit(build.commitSha),
      build.notes,
    ].filter(Boolean).join(" · ");
    const maxLabelLength = 96;
    return label.length > maxLabelLength ? `${label.slice(0, maxLabelLength - 1).trimEnd()}…` : label;
  }

  function experimentalInstallDisabled(): boolean {
    return experimentalInstallBusy
      || experimentalBuildsLoading
      || !selectedExperimentalBuildKey
      || updateBusy
      || updateStatus.checking
      || updateStatus.downloading;
  }

  function experimentalInstallButtonLabel(): string {
    if (updateStatus.channel === "experimental" && updateStatus.downloading) return "Downloading";
    if (experimentalInstallBusy || (updateStatus.channel === "experimental" && updateStatus.checking)) return "Starting install";
    return "Install selected build";
  }

  function stableUpdateButtonLabel(): string {
    if (updateStatus.channel !== "experimental" && updateStatus.downloading) return "Downloading main release";
    if (updateStatus.channel !== "experimental" && (updateStatus.checking || updateBusy)) return "Checking main release";
    return "Install latest main release";
  }

  function stableUpdateDisabled(): boolean {
    return updateActionDisabled() || !updateStatus.enabled;
  }

  function updateActionDisabled(): boolean {
    return updateBusy || experimentalInstallBusy || updateStatus.checking || updateStatus.downloading;
  }

  function shortCommit(commitSha: string): string {
    return commitSha.length > 12 ? commitSha.slice(0, 12) : commitSha;
  }

  function formatReleaseDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function errorMessage(cause: unknown, fallback: string): string {
    return cause instanceof Error && cause.message ? cause.message : fallback;
  }
</script>

<SettingsShell
  {open}
  {sections}
  {section}
  onSectionChange={(nextSection) => {
    section = nextSection;
  }}
  onClose={closeSettings}
>
  {#snippet children(activeSection)}
    {#if activeSection === "about"}
      <h2 class="text-xl font-semibold tracking-tight text-ink">About</h2>
      <div class="mt-8 max-w-xl">
        <div class="flex items-center gap-4">
          <div class="grid size-16 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-lg)] border border-line bg-white shadow-sm">
            <img src={bridgeIcon} alt="" class="size-full object-cover" />
          </div>
          <div class="min-w-0">
            <p class="text-lg font-semibold text-ink">Ambient Bridge</p>
            <p class="mt-0.5 truncate text-sm text-ink-tertiary">Secure local inference gateway</p>
          </div>
        </div>

        <dl class="card mt-6 overflow-hidden text-sm" aria-label="Bridge identity">
          <div class="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-4 px-4 py-3">
            <dt class="font-medium text-ink-tertiary">Version</dt>
            <dd class="min-w-0 break-words text-ink-secondary">{updateStatus.currentVersion ?? appVersion}</dd>
          </div>
          <div class="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-4 px-4 py-3">
            <dt class="font-medium text-ink-tertiary">Channel</dt>
            <dd class="min-w-0 break-words text-ink-secondary">{updateStatus.channel}</dd>
          </div>
          <div class="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-4 px-4 py-3">
            <dt class="font-medium text-ink-tertiary">Updates</dt>
            <dd><Pill tone="outline">{updateLabel()}</Pill></dd>
          </div>
        </dl>

        {#if updateStatus.enabled}
          <div class="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onclick={checkForUpdates}
              disabled={updateCheckDisabled()}
            >
              <Icon
                name="refresh"
                size={14}
                class={cn((updateStatus.checking || updateStatus.downloading || updateBusy) && "animate-spin")}
              />
              Check for updates
            </Button>
            {#if updateStatus.downloaded}
              <Button variant="primary" size="sm" type="button" onclick={installUpdate} disabled={updateBusy}>Restart and install</Button>
            {/if}
          </div>
        {:else}
          <p class="mt-4 text-sm leading-relaxed text-ink-tertiary">{updateStatus.reason ?? "Automatic updates are unavailable in this Bridge build."}</p>
        {/if}
        {#if updateStatus.updateError}
          <p class="mt-4 text-sm leading-relaxed text-warning">{updateStatus.updateError}</p>
        {/if}
      </div>
    {:else if activeSection === "dev" && devtoolsEnabled}
      <h2 class="text-xl font-semibold tracking-tight text-ink">Dev</h2>
      <div class="mt-8 grid gap-8">
        <section aria-labelledby="experimental-builds-title">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <h3 id="experimental-builds-title" class="text-lg font-semibold text-ink">Experimental builds</h3>
              <p class="mt-1 text-sm leading-relaxed text-ink-tertiary" aria-live="polite">{experimentalBuildsTitle()} · {experimentalBuildsDetail()}</p>
            </div>
            <Button
              variant="secondary"
              size="icon"
              type="button"
              aria-label="Refresh builds"
              onclick={() => void refreshExperimentalBuilds()}
              disabled={experimentalBuildsLoading || experimentalInstallBusy}
              icon="refresh"
            />
          </div>
          <div class="mt-4 grid gap-3">
            <div class="grid max-w-lg gap-1.5 text-sm font-medium text-ink">
              <span>Build version</span>
              <Select
                aria-label="Build version"
                class="w-full min-w-0 truncate"
                bind:value={selectedExperimentalBuildKey}
                options={experimentalBuildSelectOptions()}
                disabled={experimentalBuildOptions().length === 0 || experimentalBuildsLoading || experimentalInstallBusy}
                onValueChange={(value) => {
                  selectedExperimentalBuildKey = value;
                  experimentalBuildsError = null;
                }}
              />
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button type="button" onclick={() => void installSelectedExperimentalBuild()} disabled={experimentalInstallDisabled()}>{experimentalInstallButtonLabel()}</Button>
              <Button variant="secondary" type="button" onclick={() => void checkForStableUpdates()} disabled={stableUpdateDisabled()}>{stableUpdateButtonLabel()}</Button>
              {#if updateStatus.downloaded}
                <Button type="button" onclick={installUpdate} disabled={updateActionDisabled()}>Restart and install</Button>
              {/if}
            </div>
            <p class="text-sm leading-6 text-ink-tertiary">Current build: {experimentalBuilds?.currentVersion ?? updateStatus.currentVersion ?? appVersion}. Downgrades are allowed when switching channels.</p>
            {#if experimentalBuildsError || updateStatus.updateError}
              <p class="text-sm leading-6 text-warning" role="alert">{experimentalBuildsError ?? updateStatus.updateError}</p>
            {/if}
          </div>
        </section>
      </div>
    {/if}
  {/snippet}
</SettingsShell>
