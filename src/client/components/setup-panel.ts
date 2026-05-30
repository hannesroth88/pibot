export type SetupPanelMode = "idle" | "starting" | "started";

export class RobotSetupPanelElement extends HTMLElement {
	private startButton: HTMLButtonElement | undefined;
	private spotifyButton: HTMLButtonElement | undefined;
	private resetButton: HTMLButtonElement | undefined;

	connectedCallback(): void {
		if (!this.startButton) this.render();
	}

	set mode(mode: SetupPanelMode) {
		if (!this.startButton) return;
		this.startButton.disabled = mode === "starting";
		this.startButton.textContent =
			mode === "starting" ? "Starting..." : mode === "started" ? "Show face" : "Start robot";
	}

	private render(): void {
		this.classList.add("panel");
		this.startButton = document.createElement("button");
		this.startButton.className = "primary";
		this.startButton.textContent = "Start robot";
		this.startButton.addEventListener("click", () => this.dispatchEvent(new Event("start-robot")));

		const controls = document.createElement("div");
		controls.className = "controls";
		this.spotifyButton = document.createElement("button");
		this.spotifyButton.textContent = "Spotify";
		this.spotifyButton.addEventListener("click", () => this.dispatchEvent(new Event("spotify-setup")));
		this.resetButton = document.createElement("button");
		this.resetButton.textContent = "Reset session";
		this.resetButton.addEventListener("click", () => this.dispatchEvent(new Event("reset-session")));
		controls.append(this.spotifyButton, this.resetButton);
		this.replaceChildren(this.startButton, controls);
	}
}

customElements.define("robot-setup-panel", RobotSetupPanelElement);
