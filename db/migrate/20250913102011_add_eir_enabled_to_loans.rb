class AddEirEnabledToLoans < ActiveRecord::Migration[7.2]
  def change
    add_column :loans, :eir_enabled, :boolean, default: false
  end
end
