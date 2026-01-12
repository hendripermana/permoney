# frozen_string_literal: true

module Api
  module V1
    class SyncController < BaseController
      before_action :ensure_write_scope, only: [ :create ]

      def create
        @sync = Current.family.sync_later
        render :create, status: :accepted
      rescue => e
        Rails.logger.error "SyncController#create error: #{e.message}"
        Rails.logger.error e.backtrace.join("\n")

        render json: {
          error: "internal_server_error",
          message: "Error: #{e.message}"
        }, status: :internal_server_error
      end

      private

        def ensure_write_scope
          authorize_scope!(:write)
        end
    end
  end
end
