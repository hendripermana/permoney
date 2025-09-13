module LoanHelper
  # Returns a human-friendly label for personal lenders.
  # Prefers linked_contact_id if resolvable, otherwise falls back to lender_name/counterparty_name.
  # Output example: "Ahmad (Contact)" or "John Doe (Manual)".
  def personal_lender_label(loan)
    return nil unless loan.personal_loan?

    # Try to resolve a Contact model if present in the app (optional)
    if loan.linked_contact_id.present? && defined?(Contact)
      contact = Contact.where(id: loan.linked_contact_id).first
      if contact&.respond_to?(:name) && contact.name.present?
        return safe_join([ contact.name, content_tag(:span, "(Contact)", class: "text-secondary text-xs") ], " ")
      end
    end

    # Fallback to lender_name or counterparty_name
    lender = loan.lender_name.presence || loan.counterparty_name.presence || loan.linked_contact_id&.to_s
    return nil unless lender.present?

    safe_join([ lender, content_tag(:span, "(Manual)", class: "text-secondary text-xs") ], " ")
  end
end
