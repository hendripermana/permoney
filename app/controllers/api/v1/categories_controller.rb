# frozen_string_literal: true

module Api
  module V1
    class CategoriesController < BaseController
      before_action :ensure_read_scope
      before_action :set_category, only: :show

      def index
        categories_query = Current.family.categories.includes(:parent, :subcategories).alphabetically
        categories_query = apply_filters(categories_query)

        @pagy, @categories = pagy(
          :offset,
          categories_query,
          page: safe_page_param,
          limit: safe_per_page_param
        )

        @per_page = safe_per_page_param

        render :index
      rescue => e
        Rails.logger.error "CategoriesController#index error: #{e.message}"
        Rails.logger.error e.backtrace.join("\n")

        render json: {
          error: "internal_server_error",
          message: "Error: #{e.message}"
        }, status: :internal_server_error
      end

      def show
        render :show
      rescue => e
        Rails.logger.error "CategoriesController#show error: #{e.message}"
        Rails.logger.error e.backtrace.join("\n")

        render json: {
          error: "internal_server_error",
          message: "Error: #{e.message}"
        }, status: :internal_server_error
      end

      private

        def set_category
          @category = Current.family.categories.includes(:parent, :subcategories).find(params[:id])
        rescue ActiveRecord::RecordNotFound
          render json: {
            error: "not_found",
            message: "Category not found"
          }, status: :not_found
        end

        def ensure_read_scope
          authorize_scope!(:read)
        end

        def apply_filters(query)
          if params[:classification].present?
            query = query.where(classification: params[:classification])
          end

          if params[:roots_only].present? && ActiveModel::Type::Boolean.new.cast(params[:roots_only])
            query = query.roots
          end

          if params[:parent_id].present?
            query = query.where(parent_id: params[:parent_id])
          end

          query
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
