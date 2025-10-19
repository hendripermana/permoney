class Account::QuickSync
  def self.call(account)
    strategy = account.linked? ? :reverse : :forward
    Balance::Materializer.new(account, strategy: strategy).materialize_balances
  end
end
