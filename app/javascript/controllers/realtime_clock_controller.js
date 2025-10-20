import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static targets = ["date", "time"];

  connect() {
    this.updateClock();
    // Update every second
    this.interval = setInterval(() => this.updateClock(), 1000);
  }

  disconnect() {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  updateClock() {
    const now = new Date();

    // Format date: Monday, October 20, 2025
    const dateOptions = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    };
    const formattedDate = now.toLocaleDateString("en-US", dateOptions);

    // Format time: 14:30:45
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    const formattedTime = `${hours}:${minutes}:${seconds}`;

    // Update date if changed (only animate date changes, not every second)
    if (
      this.dateTarget.textContent !== formattedDate &&
      this.dateTarget.textContent !== "Loading..."
    ) {
      this.animateChange(this.dateTarget, formattedDate);
    } else if (this.dateTarget.textContent === "Loading...") {
      this.dateTarget.textContent = formattedDate;
    }

    // Update time with smooth animation
    if (
      this.timeTarget.textContent !== formattedTime &&
      this.timeTarget.textContent !== "--:--:--"
    ) {
      this.animateChange(this.timeTarget, formattedTime);
    } else if (this.timeTarget.textContent === "--:--:--") {
      this.timeTarget.textContent = formattedTime;
    }
  }

  animateChange(element, newText) {
    // Add animation class
    element.style.transition =
      "opacity 300ms ease-out, transform 300ms ease-out";
    element.style.opacity = "0";
    element.style.transform = "translateY(-10px)";

    setTimeout(() => {
      // Update text
      element.textContent = newText;

      // Animate in
      element.style.transform = "translateY(10px)";

      // Force reflow
      element.offsetHeight;

      element.style.opacity = "1";
      element.style.transform = "translateY(0)";
    }, 300);
  }
}
