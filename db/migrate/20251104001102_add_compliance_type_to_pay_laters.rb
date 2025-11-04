class AddComplianceTypeToPayLaters < ActiveRecord::Migration[8.1]
  def change
    add_column :pay_laters, :compliance_type, :string, default: "conventional"
    add_index :pay_laters, :compliance_type
  end
end
