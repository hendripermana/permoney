class AddExtraToTransactions < ActiveRecord::Migration[8.1]
  def change
    add_column :transactions, :extra, :jsonb, default: {}, null: false
    add_index :transactions, :extra, using: :gin
  end
end
