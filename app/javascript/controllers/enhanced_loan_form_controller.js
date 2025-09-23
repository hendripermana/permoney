import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static targets = [
    "personalCard", "institutionalCard", 
    "personalFields", "institutionalFields",
    "personalInterestSection", "interestFields",
    "lenderName", "relationship", "loanAmount", "termMonths",
    "institutionName", "fintechType",
    "interestRate", "rateType", "paymentFrequency", "startDate", "originationDate",
    "debtKindField", "counterpartyTypeField",
    "essentialSection", "interestSection", "disbursementSection", "advancedSection"
  ]
  
  static values = { 
    personalMode: Boolean 
  }

  connect() {
    // Initialize form based on current mode
    if (this.personalModeValue) {
      this.selectPersonal()
    } else {
      this.selectInstitutional()
    }
    
    // Set up smart defaults
    this.setSmartDefaults()
  }

  selectPersonal() {
    // Update UI state
    this.updateCardSelection(this.personalCardTarget, this.institutionalCardTarget)
    this.showPersonalFields()
    
    // Update hidden fields
    this.debtKindFieldTarget.value = "personal"
    this.counterpartyTypeFieldTarget.value = "person"
    
    // Set smart defaults for personal loans
    this.setPersonalDefaults()
  }

  selectInstitutional() {
    // Update UI state
    this.updateCardSelection(this.institutionalCardTarget, this.personalCardTarget)
    this.showInstitutionalFields()
    
    // Update hidden fields
    this.debtKindFieldTarget.value = "institutional"
    this.counterpartyTypeFieldTarget.value = "institution"
    
    // Set smart defaults for institutional loans
    this.setInstitutionalDefaults()
  }

  updateCardSelection(selectedCard, unselectedCard) {
    // Add selected styling
    selectedCard.classList.add("ring-2", "ring-primary", "bg-primary/5")
    selectedCard.classList.remove("border-secondary")
    
    // Remove selected styling
    unselectedCard.classList.remove("ring-2", "ring-primary", "bg-primary/5")
    unselectedCard.classList.add("border-secondary")
  }

  showPersonalFields() {
    this.personalFieldsTarget.classList.remove("hidden")
    this.institutionalFieldsTarget.classList.add("hidden")
    this.personalInterestSectionTarget.classList.remove("hidden")
  }

  showInstitutionalFields() {
    this.personalFieldsTarget.classList.add("hidden")
    this.institutionalFieldsTarget.classList.remove("hidden")
    this.personalInterestSectionTarget.classList.add("hidden")
  }

  setPersonalDefaults() {
    // Smart defaults for personal loans
    if (!this.interestRateTarget.value) {
      this.interestRateTarget.value = "0" // Usually interest-free
    }
    
    if (!this.termMonthsTarget.value) {
      this.termMonthsTarget.value = "12" // Shorter terms for personal loans
    }
    
    // Set payment frequency if not set
    if (!this.paymentFrequencyTarget.value) {
      this.paymentFrequencyTarget.value = "MONTHLY"
    }
  }

  setInstitutionalDefaults() {
    // Smart defaults for institutional loans
    if (!this.interestRateTarget.value) {
      // Set based on currency (Indonesian context)
      const currency = document.querySelector('meta[name="family-currency"]')?.content || "IDR"
      this.interestRateTarget.value = currency === "IDR" ? "12" : "6"
    }
    
    if (!this.termMonthsTarget.value) {
      this.termMonthsTarget.value = "24" // Longer terms for institutional loans
    }
    
    // Set payment frequency if not set
    if (!this.paymentFrequencyTarget.value) {
      this.paymentFrequencyTarget.value = "MONTHLY"
    }
  }

  setSmartDefaults() {
    // Set smart date defaults
    const nextMonth = new Date()
    nextMonth.setMonth(nextMonth.getMonth() + 1)
    
    if (this.startDateTarget && !this.startDateTarget.value) {
      this.startDateTarget.value = nextMonth.toISOString().split('T')[0]
    }
    
    if (this.originationDateTarget && !this.originationDateTarget.value) {
      this.originationDateTarget.value = new Date().toISOString().split('T')[0]
    }
  }

  // Handle interest-free toggle for personal loans
  toggleInterestFree(event) {
    const isChecked = event.target.checked
    const interestFields = this.interestFieldsTarget
    
    if (isChecked) {
      interestFields.classList.add("opacity-50", "pointer-events-none")
      this.interestRateTarget.value = "0"
    } else {
      interestFields.classList.remove("opacity-50", "pointer-events-none")
      // Reset to smart default
      this.setPersonalDefaults()
    }
  }

  // Handle form validation and feedback
  validateForm() {
    const errors = []
    
    // Check required fields
    if (!this.lenderNameTarget.value && !this.institutionNameTarget.value) {
      errors.push("Lender/Institution name is required")
    }
    
    if (!this.loanAmountTarget.value || parseFloat(this.loanAmountTarget.value) <= 0) {
      errors.push("Loan amount must be greater than 0")
    }
    
    if (!this.termMonthsTarget.value || parseInt(this.termMonthsTarget.value) <= 0) {
      errors.push("Repayment period must be at least 1 month")
    }
    
    return errors
  }

  // Show contextual help based on loan type
  showContextualHelp(field) {
    const helpMessages = {
      personal: {
        lenderName: "Enter the name of the person you're borrowing from",
        relationship: "Select your relationship to help with reminders and context",
        loanAmount: "Enter the total amount you're borrowing",
        termMonths: "How many months will you take to repay this loan?"
      },
      institutional: {
        institutionName: "Enter the name of the bank or institution",
        fintechType: "Select the type of institution for better categorization",
        loanAmount: "Enter the total loan amount from the institution",
        termMonths: "The loan term in months (usually 12-60 for personal loans)"
      }
    }
    
    const loanType = this.debtKindFieldTarget.value
    const message = helpMessages[loanType]?.[field]
    
    if (message) {
      this.showTooltip(message)
    }
  }

  showTooltip(message) {
    // Simple tooltip implementation
    const tooltip = document.createElement('div')
    tooltip.className = 'absolute z-10 px-2 py-1 text-xs text-white bg-gray-800 rounded shadow-lg'
    tooltip.textContent = message
    
    // Position and show tooltip (simplified)
    document.body.appendChild(tooltip)
    
    setTimeout(() => {
      document.body.removeChild(tooltip)
    }, 3000)
  }

  // Auto-format currency input
  formatCurrency(event) {
    const input = event.target
    let value = input.value.replace(/[^\d]/g, '')
    
    if (value) {
      // Add thousand separators for Indonesian context
      const formatted = new Intl.NumberFormat('id-ID').format(value)
      input.value = formatted
    }
  }

  // Calculate estimated monthly payment
  calculateMonthlyPayment() {
    const amount = parseFloat(this.loanAmountTarget?.value || 0)
    const term = parseInt(this.termMonthsTarget?.value || 0)
    const rate = parseFloat(this.interestRateTarget?.value || 0) / 100
    
    if (amount > 0 && term > 0) {
      if (rate === 0) {
        // Simple interest-free calculation
        return amount / term
      } else {
        // Annuity calculation (simplified)
        const monthlyRate = rate / 12
        const monthlyPayment = amount * (monthlyRate * Math.pow(1 + monthlyRate, term)) / 
                              (Math.pow(1 + monthlyRate, term) - 1)
        return monthlyPayment
      }
    }
    
    return 0
  }


  // Prepare preview data for schedule popup
  preparePreview(event) {
    event.preventDefault()
    
    // Collect form data
    const formData = this.collectFormData()
    
    // Build preview URL with parameters
    const previewUrl = this.buildPreviewUrl(formData)
    
    // Create modal popup instead of new tab
    this.openModalPreview(previewUrl)
  }

  // Open preview in modal popup
  openModalPreview(url) {
    // Create modal overlay that will appear above HTML dialog elements
    const modal = document.createElement('div')
    modal.id = 'loan-preview-modal'
    
    // Use extremely high z-index that's higher than browser's native dialog z-index
    modal.style.cssText = `
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      z-index: 2147483647 !important;
      background-color: rgba(0, 0, 0, 0.6) !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      pointer-events: auto !important;
      backdrop-filter: blur(4px) !important;
    `
    
    modal.innerHTML = `
      <div class="bg-container border border-secondary rounded-lg shadow-2xl max-w-5xl w-full mx-4 max-h-[90vh] overflow-hidden" style="z-index: 1000000 !important; position: relative !important; pointer-events: auto !important;">
        <div class="flex items-center justify-between p-6 border-b border-secondary bg-surface">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <svg class="w-4 h-4 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
              </svg>
            </div>
            <div>
              <h3 class="text-lg font-semibold text-primary">Payment Schedule Preview</h3>
              <p class="text-sm text-secondary">Review your loan repayment plan</p>
            </div>
          </div>
          <button class="text-secondary hover:text-primary transition-colors p-2 rounded-lg hover:bg-secondary/10" onclick="this.closest('.fixed').remove()">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>
        <div class="p-6 overflow-auto max-h-[calc(90vh-120px)]">
          <div class="bg-surface border border-secondary rounded-lg p-4 mb-4">
            <div class="flex items-center gap-2 text-sm text-secondary mb-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
              <span>This preview shows your estimated payment schedule based on the current form data.</span>
            </div>
          </div>
          <iframe src="${url}" class="w-full h-[500px] border border-secondary rounded-lg bg-white"></iframe>
        </div>
      </div>
    `
    
    // Remove any existing modal first
    const existingModal = document.getElementById('loan-preview-modal')
    if (existingModal) {
      existingModal.remove()
    }
    
    // Force modal to be on top by temporarily lowering all other high z-index elements
    const allElements = document.querySelectorAll('*')
    const originalZIndexes = []
    
    allElements.forEach((el, index) => {
      const computedStyle = window.getComputedStyle(el)
      const zIndex = computedStyle.zIndex
      if (zIndex !== 'auto' && parseInt(zIndex) > 1000) {
        originalZIndexes[index] = { element: el, zIndex: zIndex }
        el.style.zIndex = '1'
      }
    })
    
    // Store for restoration
    modal._originalZIndexes = originalZIndexes
    
    // Add to body with maximum priority
    document.body.appendChild(modal)
    
    // Prevent body scroll when modal is open
    document.body.style.overflow = 'hidden'
    
    // Close on overlay click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.closeModal(modal)
      }
    })
    
    // Close on escape key
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        this.closeModal(modal)
        document.removeEventListener('keydown', handleEscape)
      }
    }
    document.addEventListener('keydown', handleEscape)
    
    // Store reference for cleanup
    modal._escapeHandler = handleEscape
  }

  // Close modal helper
  closeModal(modal) {
    // Restore original z-indexes
    if (modal._originalZIndexes) {
      modal._originalZIndexes.forEach(({ element, zIndex }) => {
        if (element && zIndex) {
          element.style.zIndex = zIndex
        }
      })
    }
    
    document.body.style.overflow = '' // Restore body scroll
    if (modal._escapeHandler) {
      document.removeEventListener('keydown', modal._escapeHandler)
    }
    modal.remove()
  }

  // Collect form data for preview
  collectFormData() {
    const data = {
      initial_balance: this.loanAmountTarget?.value || 0,
      interest_rate: this.interestRateTarget?.value || 0,
      term_months: this.termMonthsTarget?.value || 12,
      payment_frequency: this.paymentFrequencyTarget?.value || 'MONTHLY',
      schedule_method: 'ANNUITY', // Default method
      start_date: this.startDateTarget?.value || new Date().toISOString().split('T')[0]
    }
    
    return data
  }

  // Build preview URL with form data
  buildPreviewUrl(formData) {
    const baseUrl = this.data.get('preview-base-href') || '/loans/schedule_preview'
    const params = new URLSearchParams(formData)
    
    return `${baseUrl}?${params.toString()}`
  }
}
