class AddIndonesianTransactionTypes < ActiveRecord::Migration[7.2]
  def change
    # This migration updates the transaction kind enum to include Indonesian financial patterns
    # The actual enum values will be updated in the Transaction model
    
    # Add a column to track Islamic compliance for transactions
    add_column :transactions, :is_sharia_compliant, :boolean, default: true
    add_column :transactions, :islamic_transaction_type, :string # For specific Islamic finance tracking
    
    # Add indexes for filtering
    add_index :transactions, :is_sharia_compliant
    add_index :transactions, :islamic_transaction_type
  end
end
