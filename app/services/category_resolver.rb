class CategoryResolver
  SYSTEM_CATEGORIES = {
    "system:interest_expense" => { name: "Interest Expense", classification: "expense", icon: "badge-dollar-sign" },
    "system:islamic_profit_expense" => { name: "Profit Expense", classification: "expense", icon: "badge-dollar-sign" },
    "system:late_fee_expense" => { name: "Late Fee Expense", classification: "expense", icon: "badge-dollar-sign" },
    "system:admin_fee_expense" => { name: "Loan Admin Fee", classification: "expense", icon: "badge-dollar-sign" }
  }.freeze

  def self.ensure_system_category(family, key)
    meta = SYSTEM_CATEGORIES.fetch(key) { raise ArgumentError, "Unknown system category key: #{key}" }

    if Category.column_names.include?("key")
      found = family.categories.where(key: key).first
      return found if found
    end

    # Fallback to name match
    found_by_name = family.categories.where(name: meta[:name]).first
    if found_by_name
      found_by_name.update!(key: key) if found_by_name.respond_to?(:key) && found_by_name.key.blank?
      return found_by_name
    end

    # Create if missing (idempotent)
    cat = family.categories.create!(
      name: meta[:name],
      classification: meta[:classification] || "expense",
      lucide_icon: meta[:icon] || "shapes",
      key: (Category.column_names.include?("key") ? key : nil)
    )
    cat
  end
end
