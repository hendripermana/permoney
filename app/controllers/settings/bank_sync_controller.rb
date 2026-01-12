class Settings::BankSyncController < ApplicationController
  layout "settings"

  def show
    @providers = [
      {
        name: "Lunch Flow",
        description: "US, Canada, UK, EU, Brazil and Asia through multiple open banking providers.",
        path: "https://lunchflow.app/features/sure-integration",
        target: "_blank",
        rel: "noopener noreferrer",
        data_turbo: false
      },
      {
        name: "Plaid",
        description: "US & Canada bank connections with transactions, investments, and liabilities.",
        path: "https://github.com/hendripermana/permoney/blob/main/docs/hosting/plaid.md",
        target: "_blank",
        rel: "noopener noreferrer",
        data_turbo: false
      },
      {
        name: "SimpleFIN",
        description: "US & Canada connections via SimpleFin protocol.",
        path: "https://beta-bridge.simplefin.org",
        target: "_blank",
        rel: "noopener noreferrer"
      }
    ]
  end
end
