class Loan::DisburseMore
  Result = Struct.new(:success?, :entry, :transfer, :error, keyword_init: true)

  # Public API requested: account:, amount:, date:, cash_account:
  def self.call(account:, amount:, date:, cash_account:)
    family = account.family
    params = {
      loan_account_id: account.id,
      amount: amount,
      transfer_account_id: cash_account&.id,
      date: date
    }
    res = Loan::AdditionalBorrowingService.call!(family:, params: params)
    Result.new(success?: res.success?, entry: res.entry, transfer: res.transfer, error: res.error)
  end
end

