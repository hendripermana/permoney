class Rule::ActionExecutor::ExcludeTransaction < Rule::ActionExecutor
  def label
    "Exclude from budgeting and reports"
  end

  def execute(transaction_scope, value: nil, ignore_attribute_locks: false)
    scope = transaction_scope.with_entry
    scope = scope.where.not(Arel.sql("entries.locked_attributes ? 'excluded'")) unless ignore_attribute_locks

    scope.each do |txn|
      txn.entry.enrich_attribute(
        :excluded,
        true,
        source: "rule"
      )
    end
  end
end
