class ServiceMerchant::ComboboxOption
  include ActiveModel::Model

  attr_accessor :id, :name, :logo_url, :category, :billing_frequency, :avg_monthly_cost, :formatted_cost

  def to_combobox_display
    name
  end
end
