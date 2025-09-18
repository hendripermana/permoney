import { Controller } from "@hotwired/stimulus"

const { Turbo } = window

// Connects to data-controller="loan-form"
export default class extends Controller {
  static targets = [
    "subtype",
    "compliance",
    "islamicProduct",
    "interestSection",
    "profitSection",
    "interestFree",
    "interestToggle",
    "marginField",
    "profitShareField",
    "rateOrProfit",
    "frequency",
    "method",
    "principal",
    "tenor",
    "debtKindField",
    "counterpartyTypeField",
    "visibility",
    "previewLink",
    "previewOverlay",
    "previewPanel"
  ]

  static values = {
    interestFreeTouched: Boolean,
    previewBaseHref: String,
    previewFrame: String,
    previewAuto: Boolean
  }

  initialize() {
    this.previewTimeout = null
  }

  connect() {
    this.syncAll()
    if (this.previewAutoValue && this.previewFrameValue) {
      this.updatePreviewDestination({ trigger: "auto" })
    }
  }

  onSubtypeChange() {
    this.syncSubtype()
    this.syncCompliance()
    this.syncInterestMode()
    this.queuePreview()
  }

  onComplianceChange() {
    this.syncCompliance()
    this.syncInterestMode()
    this.queuePreview()
  }

  onIslamicProductChange() {
    this.syncIslamicProduct()
    this.syncInterestMode()
    this.queuePreview()
  }

  onInterestFreeChange() {
    this.interestFreeTouchedValue = true
    this.syncInterestMode()
    this.queuePreview()
  }

  // Debounced auto preview on terms change
  termsChanged() {
    this.queuePreview()
  }

  syncAll() {
    this.syncSubtype()
    this.syncCompliance()
    this.syncInterestMode()
  }

  syncSubtype() {
    const personal = this.currentSubtype() === "loan_personal"

    if (this.hasVisibilityTarget) {
      this.visibilityTargets.forEach((element) => {
        const raw = element.dataset.loanFormVisibilityValue || ""
        const rules = raw.split(",").map((token) => token.trim()).filter(Boolean)

        if (rules.length === 0) {
          this.toggleSection(element, true)
          return
        }

        const shouldShow = rules.some((rule) => {
          if (rule === "personal") return personal
          if (rule === "institution") return !personal
          return true
        })

        this.toggleSection(element, shouldShow)
      })
    }

    if (this.hasDebtKindFieldTarget) {
      this.debtKindFieldTarget.value = personal ? "personal" : "institutional"
    }

    if (this.hasCounterpartyTypeFieldTarget) {
      this.counterpartyTypeFieldTarget.value = personal ? "person" : "institution"
    }

    if (personal && this.hasComplianceTarget && !this.complianceTarget.value) {
      this.complianceTarget.value = "conventional"
    }

    if (personal && this.hasInterestFreeTarget && !this.interestFreeTouchedValue) {
      this.interestFreeTarget.checked = true
    }

    if (!personal && this.hasInterestFreeTarget && !this.interestFreeTouchedValue && !this.isSharia()) {
      this.interestFreeTarget.checked = false
    }
  }

  syncCompliance() {
    const sharia = this.isSharia()
    if (this.hasInterestToggleTarget) {
      this.toggleSection(this.interestToggleTarget, !sharia)
    }
    if (this.hasProfitSectionTarget) {
      this.toggleSection(this.profitSectionTarget, sharia)
    }
    this.syncIslamicProduct()
  }

  syncInterestMode() {
    const sharia = this.isSharia()
    const personal = this.currentSubtype() === "loan_personal"

    if (!sharia && this.hasInterestFreeTarget && !this.interestFreeTouchedValue) {
      this.interestFreeTarget.checked = personal
    }

    const interestFreeEnabled = this.hasInterestFreeTarget ? this.interestFreeTarget.checked : false

    if (this.hasInterestSectionTarget) {
      this.toggleSection(this.interestSectionTarget, !sharia && !interestFreeEnabled)
    }

    if (!sharia && interestFreeEnabled && this.hasRateOrProfitTarget) {
      if (!this.rateOrProfitTarget.value || this.rateOrProfitTarget.value.length === 0) {
        this.rateOrProfitTarget.value = "0"
      }
    }

    if (sharia && this.hasInterestFreeTarget) {
      this.interestFreeTarget.checked = false
    }
  }

  syncIslamicProduct() {
    if (!this.hasProfitSectionTarget) return

    const product = this.hasIslamicProductTarget ? this.islamicProductTarget.value : null
    const showMargin = product === "murabaha"
    const showProfit = ["musyarakah", "mudharabah"].includes(product)

    this.toggleSection(this.marginFieldTarget, showMargin)
    this.toggleSection(this.profitShareFieldTarget, showProfit)

    if (!showMargin && this.hasMarginFieldTarget) {
      const input = this.marginFieldTarget.querySelector("input")
      if (input) input.value = ""
    }

    if (!showProfit && this.hasProfitShareFieldTarget) {
      const input = this.profitShareFieldTarget.querySelector("input")
      if (input) input.value = ""
    }
  }

  toggleSection(target, show) {
    if (!target) return
    target.classList.toggle("hidden", !show)
    target.setAttribute("aria-hidden", show ? "false" : "true")
  }

  currentSubtype() {
    return this.hasSubtypeTarget ? this.subtypeTarget.value : null
  }

  currentCompliance() {
    return this.hasComplianceTarget ? this.complianceTarget.value : null
  }

  isSharia() {
    return this.currentCompliance() === "sharia"
  }

  queuePreview() {
    clearTimeout(this.previewTimeout)
    this.previewTimeout = setTimeout(() => this.updatePreviewDestination({ trigger: "auto" }), 400)
  }

  updatePreviewDestination({ trigger } = {}) {
    if (!this.previewBaseHrefValue || !this.hasPreviewLinkTarget) return

    const params = this.buildPreviewParams()
    if (!params) {
      this.previewLinkTarget.href = this.previewBaseHrefValue
      return
    }

    const url = new URL(this.previewBaseHrefValue, window.location.origin)
    params.forEach((value, key) => {
      url.searchParams.set(key, value)
    })

    const finalUrl = url.pathname + (url.search ? url.search : "")
    this.previewLinkTarget.href = finalUrl

    const frame = this.previewFrameValue
    const shouldVisit = frame && (trigger === "manual" || this.previewIsOpen())

    if (shouldVisit) {
      Turbo.visit(finalUrl, { frame })
    }

    if (trigger === "manual") {
      this.openPreview()
    }
  }

  preparePreview(event) {
    event.preventDefault()
    this.updatePreviewDestination({ trigger: "manual" })
  }

  buildPreviewParams() {
    const principal =
      this.fieldValue("account[accountable_attributes][initial_balance]") ||
      this.fieldValue("account[accountable_attributes][principal_amount]")
    const tenor = this.fieldValue("account[accountable_attributes][tenor_months]")

    if (!principal || !tenor) {
      return null
    }

    const params = new URLSearchParams()
    params.set("principal_amount", principal)
    params.set("tenor_months", tenor)

    const frequency = this.fieldValue("account[accountable_attributes][payment_frequency]") || "MONTHLY"
    params.set("payment_frequency", frequency)

    const scheduleMethod = this.fieldValue("account[accountable_attributes][schedule_method]") || "ANNUITY"
    params.set("schedule_method", scheduleMethod)

    const startDate = this.fieldValue("account[accountable_attributes][start_date]")
    if (startDate) params.set("start_date", startDate)

    const balloon = this.fieldValue("account[accountable_attributes][balloon_amount]")
    if (balloon) params.set("balloon_amount", balloon)

    const rate = this.fieldValue("account[accountable_attributes][rate_or_profit]")
    const interestFree = this.checkboxChecked("account[accountable_attributes][interest_free]")
    params.set("interest_free", interestFree ? "true" : "false")
    params.set("rate_or_profit", interestFree ? "0" : (rate || "0"))

    return params
  }

  fieldValue(name) {
    const fields = Array.from(this.element.querySelectorAll(`[name="${name}"]`))
    if (fields.length === 0) return null

    const field = fields.find((el) => el.type !== "hidden") || fields[0]

    if (field.type === "checkbox") {
      return field.checked ? field.value : null
    }

    return field.value
  }

  checkboxChecked(name) {
    const checkbox = this.element.querySelector(`input[type="checkbox"][name="${name}"]`)
    return checkbox ? checkbox.checked : false
  }

  previewIsOpen() {
    return this.hasPreviewOverlayTarget && !this.previewOverlayTarget.classList.contains("hidden")
  }

  openPreview() {
    if (!this.hasPreviewOverlayTarget || !this.hasPreviewPanelTarget) return

    if (!this.previewIsOpen()) {
      this.previewOverlayTarget.classList.remove("hidden")
      this.previewOverlayTarget.classList.add("flex")
      this.previewOverlayTarget.classList.add("opacity-0")
      this.previewPanelTarget.classList.add("opacity-0", "scale-95")
      requestAnimationFrame(() => {
        this.previewOverlayTarget.classList.remove("opacity-0")
        this.previewOverlayTarget.classList.add("opacity-100")
        this.previewPanelTarget.classList.remove("opacity-0", "scale-95")
        this.previewPanelTarget.classList.add("opacity-100", "scale-100")
      })
    }
  }

  closePreview(event) {
    if (event) event.preventDefault()
    if (!this.hasPreviewOverlayTarget || !this.hasPreviewPanelTarget) return

    this.previewOverlayTarget.classList.remove("opacity-100")
    this.previewOverlayTarget.classList.add("opacity-0")
    this.previewPanelTarget.classList.remove("scale-100", "opacity-100")
    this.previewPanelTarget.classList.add("scale-95", "opacity-0")

    setTimeout(() => {
      this.previewOverlayTarget.classList.add("hidden")
      this.previewOverlayTarget.classList.remove("flex")
    }, 180)
  }
}
