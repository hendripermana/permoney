import { Controller } from "@hotwired/stimulus"

// Connects to data-controller="pay-later-purchase"
export default class extends Controller {
  static targets = ["amountInput", "tenorInput", "submitButton"]
  static values = {
    previewUrl: String
  }

  connect() {
    console.log("PayLater purchase controller connected")
  }

  previewSchedule(event) {
    event?.preventDefault()

    const amount = this.amountInputTarget.value
    const tenor = this.tenorInputTarget.value

    if (!amount || amount <= 0 || !tenor || tenor <= 0) {
      return
    }

    const url = new URL(this.previewUrlValue, window.location.origin)
    url.searchParams.set("amount", amount)
    url.searchParams.set("tenor_months", tenor)

    // Fetch preview via Turbo Stream
    fetch(url, {
      headers: {
        "Accept": "text/vnd.turbo-stream.html"
      }
    })
    .then(response => response.text())
    .then(html => {
      Turbo.renderStreamMessage(html)
    })
    .catch(error => {
      console.error("Error loading installment preview:", error)
    })
  }

  // Validate before submit
  submit(event) {
    const amount = parseFloat(this.amountInputTarget.value)
    if (amount <= 0) {
      event.preventDefault()
      alert("Please enter a valid purchase amount")
      return false
    }
    return true
  }
}
