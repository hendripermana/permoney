# frozen_string_literal: true

module Api
  module V1
    class AccountsController < BaseController
      before_action :ensure_read_scope

      def index
        family = current_resource_owner.family
        accounts_query = family.accounts.visible.alphabetically

        @pagy, @accounts = pagy(
          :offset,
          accounts_query,
          page: safe_page_param,
          limit: safe_per_page_param
        )

        @per_page = safe_per_page_param

        render :index
      rescue => e
        Rails.logger.error "AccountsController error: #{e.message}"
        Rails.logger.error e.backtrace.join("\n")

        render json: {
          error: "internal_server_error",
          message: "Error: #{e.message}"
        }, status: :internal_server_error
      end

      private

        def ensure_read_scope
          authorize_scope!(:read)
        end

        def safe_page_param
          page = params[:page].to_i
          page.positive? ? page : 1
        end

        def safe_per_page_param
          per_page = params[:per_page].to_i

          case per_page
          when 1..100
            per_page
          else
            25
          end
        end
    end
  end
end
