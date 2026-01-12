class Rule::ConditionFilter::TransactionDetails < Rule::ConditionFilter
  def type
    "text"
  end

  def prepare(scope)
    scope
  end

  def apply(scope, operator, value)
    sanitized_operator = sanitize_operator(operator)

    if sanitized_operator == "IS NULL"
      scope.where("transactions.extra IS NULL OR transactions.extra = '{}'::jsonb")
    else
      sanitized_value = "%#{ActiveRecord::Base.sanitize_sql_like(value)}%"
      sql_operator = sanitized_operator == "ILIKE" ? "ILIKE" : "LIKE"

      scope.where("transactions.extra::text #{sql_operator} ?", sanitized_value)
    end
  end
end
