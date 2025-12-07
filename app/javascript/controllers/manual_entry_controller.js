import { Controller } from "@hotwired/stimulus"

// Ensures manual entry form stays usable across Turbo refreshes:
// - disables submit while the request is in flight
// - re-enables (and resets on success) when Turbo finishes
export default class extends Controller {
  static targets = ["submit"]

  disable() {
    if (this.hasSubmitTarget) this.submitTarget.disabled = true
  }

  enable(event) {
    if (this.hasSubmitTarget) this.submitTarget.disabled = false
    if (event?.detail?.success && this.element instanceof HTMLFormElement) {
      this.element.reset()
    }
  }
}
