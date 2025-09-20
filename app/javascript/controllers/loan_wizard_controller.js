import { Controller } from "@hotwired/stimulus";

// Connects to data-controller="loan-wizard"
export default class LoanWizardController extends Controller {
  static targets = ["steps", "content", "currentStep", "loanType"];
  static values = {
    currentStep: String,
    loanType: String,
    completedSteps: Array
  };

  connect() {
    this.initializeWizard();
  }

  initializeWizard() {
    if (!this.currentStepValue) {
      this.currentStepValue = 'type';
    }
    this.updateUI();
  }

  selectType(event) {
    const type = event.currentTarget.dataset.typeValue;
    this.loanTypeValue = type;
    this.updateFormFields(type);
    this.nextStep();
  }

  nextStep() {
    const steps = ['type', 'basic', 'terms', 'review'];
    const currentIndex = steps.indexOf(this.currentStepValue);

    if (currentIndex < steps.length - 1 && this.validateCurrentStep()) {
      this.currentStepValue = steps[currentIndex + 1];
      this.updateUI();
    }
  }

  previousStep() {
    const steps = ['type', 'basic', 'terms', 'review'];
    const currentIndex = steps.indexOf(this.currentStepValue);

    if (currentIndex > 0) {
      this.currentStepValue = steps[currentIndex - 1];
      this.updateUI();
    }
  }

  updateUI() {
    this.updateStepIndicators();
    this.updateContentVisibility();
    this.updateActionButtons();
  }

  updateStepIndicators() {
    const steps = ['type', 'basic', 'terms', 'review'];
    const currentIndex = steps.indexOf(this.currentStepValue);

    steps.forEach((step, index) => {
      const indicator = this.element.querySelector(`[data-step="${step}"]`);
      if (indicator) {
        const isCompleted = this.completedStepsValue.includes(step) || index < currentIndex;
        const isActive = step === this.currentStepValue;

        indicator.classList.toggle('bg-primary', isCompleted);
        indicator.classList.toggle('bg-secondary', !isCompleted);
        indicator.classList.toggle('text-white', isCompleted);
        indicator.classList.toggle('text-secondary', !isCompleted);
      }
    });
  }

  updateContentVisibility() {
    const contents = this.element.querySelectorAll('[data-step-content]');
    contents.forEach(content => {
      content.style.display = content.dataset.stepContent === this.currentStepValue ? 'block' : 'none';
    });
  }

  updateActionButtons() {
    const backBtn = this.element.querySelector('[data-action*="previousStep"]');
    const nextBtn = this.element.querySelector('[data-action*="nextStep"]');

    if (backBtn) {
      backBtn.style.display = this.currentStepValue === 'type' ? 'none' : 'inline-flex';
    }

    if (nextBtn) {
      const isLastStep = this.currentStepValue === 'review';
      nextBtn.textContent = isLastStep ? 'Create Loan' : 'Next';
    }
  }

  updateFormFields(type) {
    const debtKindField = this.element.querySelector('[name*="debt_kind"]');
    const counterpartyTypeField = this.element.querySelector('[name*="counterparty_type"]');

    if (debtKindField) {
      debtKindField.value = type;
    }

    if (counterpartyTypeField) {
      counterpartyTypeField.value = type === 'personal' ? 'person' : 'institution';
    }
  }

  validateCurrentStep() {
    switch (this.currentStepValue) {
      case 'type':
        return this.validateTypeStep();
      case 'basic':
        return this.validateBasicStep();
      case 'terms':
        return this.validateTermsStep();
      default:
        return true;
    }
  }

  validateTypeStep() {
    return this.loanTypeValue && ['personal', 'institutional'].includes(this.loanTypeValue);
  }

  validateBasicStep() {
    const counterpartyName = this.element.querySelector('input[name*="counterparty_name"]');
    return counterpartyName && counterpartyName.value.trim().length > 0;
  }

  validateTermsStep() {
    const principal = this.element.querySelector('input[name*="initial_balance"]');
    const tenor = this.element.querySelector('input[name*="tenor_months"]');

    const principalValid = principal && parseFloat(principal.value) > 0;
    const tenorValid = tenor && parseInt(tenor.value) > 0;

    if (!principalValid) {
      this.showError(principal, 'Principal amount is required');
    }

    if (!tenorValid) {
      this.showError(tenor, 'Number of installments is required');
    }

    return principalValid && tenorValid;
  }

  showError(field, message) {
    if (!field) return;

    this.clearError(field);

    field.classList.add('border-red-500');
    const errorDiv = document.createElement('div');
    errorDiv.className = 'text-red-500 text-xs mt-1';
    errorDiv.textContent = message;
    field.parentNode.appendChild(errorDiv);
  }

  clearError(field) {
    if (!field) return;

    field.classList.remove('border-red-500');
    const error = field.parentNode.querySelector('.text-red-500');
    if (error) error.remove();
  }
}