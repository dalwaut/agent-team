/* OP WordPress — WooCommerce views */

WP.Woo = {
    productsPage: 1,
    allLoadedProducts: [],
    ordersPage: 1,
    ordersSearch: '',
    ordersStatus: '',
    customersPage: 1,
    customersSearch: '',
    wooStatus: null,

    async checkStatus() {
        if (!WP.currentSite) return null;
        try {
            WP.Woo.wooStatus = await WP.api(`sites/${WP.currentSite.id}/woo/status`);
        } catch (e) {
            WP.Woo.wooStatus = { enabled: false, has_keys: false, mode: 'none' };
        }
        return WP.Woo.wooStatus;
    },

    isBasicMode() {
        return WP.Woo.wooStatus && WP.Woo.wooStatus.mode === 'basic';
    },

    basicModeBanner() {
        return '<div class="callout callout-warn" style="margin-bottom:20px">' +
            '<span class="callout-icon">&#9888;</span>' +
            '<div>' +
                '<strong>Basic Mode</strong> — No WooCommerce API keys configured.<br>' +
                'You can browse products, but orders, customers, reports, and write operations require WC API keys.<br>' +
                '<span style="font-size:11px;color:var(--text-muted)">Add keys: Edit site &rarr; WooCommerce section &rarr; Consumer Key &amp; Secret</span>' +
            '</div>' +
        '</div>';
    },

    keysRequiredPage(main, title, icon, noun) {
        main.innerHTML =
            '<div class="main-header"><h2>' + title + ' — ' + WP.stripHtml(WP.currentSite.name) + '</h2></div>' +
            '<div class="callout callout-warn" style="margin-bottom:20px">' +
                '<span class="callout-icon">&#128274;</span>' +
                '<div>' +
                    '<strong>WooCommerce API Keys Required</strong><br>' +
                    noun + ' management requires WC Consumer Key and Secret.<br>' +
                    '<span style="font-size:11px;color:var(--text-muted)">Add keys: Edit site &rarr; WooCommerce section &rarr; Consumer Key &amp; Secret</span>' +
                '</div>' +
            '</div>' +
            '<div class="empty-state">' +
                '<div class="empty-icon">' + icon + '</div>' +
                '<h3>' + noun + ' require API keys</h3>' +
                '<p>Without WooCommerce API keys, ' + noun.toLowerCase() + ' data is not accessible.</p>' +
                '<button class="btn btn-primary" onclick="WP.navigate(\'sites\')">Edit Sites</button>' +
            '</div>';
    },

    // ═══════════════════════════════════════════════════════════
    //  PRODUCTS
    // ═══════════════════════════════════════════════════════════

    async renderProducts(main) {
        if (!WP.requireSite(main)) return;
        if (!WP.currentSite.is_woocommerce) {
            main.innerHTML = '<div class="empty-state"><div class="empty-icon">&#128722;</div><h3>WooCommerce not enabled</h3><p>Enable WooCommerce for this site in site settings.</p></div>';
            return;
        }

        const status = await WP.Woo.checkStatus();
        const isBasic = WP.Woo.isBasicMode();

        WP.Woo.productsPage = 1;
        WP.Woo.allLoadedProducts = [];

        main.innerHTML =
            '<div class="main-header">' +
                '<h2>Products — ' + WP.stripHtml(WP.currentSite.name) + '</h2>' +
                (isBasic ? '' : '<button class="btn btn-woo" onclick="WP.Woo.showProductModal()">+ New Product</button>') +
            '</div>' +
            (isBasic ? WP.Woo.basicModeBanner() : '') +
            '<div id="products-content"><div class="spinner" style="margin:40px auto"></div></div>';

        try {
            const result = await WP.api('sites/' + WP.currentSite.id + '/woo/products?page=' + WP.Woo.productsPage + '&per_page=20');
            const products = result.data || [];
            WP.Woo.allLoadedProducts = products;
            WP.Woo.productsPage++;
            WP.Woo.renderProductsTable();
        } catch (e) {
            document.getElementById('products-content').innerHTML =
                '<p style="color:var(--red)">Failed to load products: ' + e.message + '</p>';
        }
    },

    renderProductsTable() {
        const el = document.getElementById('products-content');
        if (!Array.isArray(WP.Woo.allLoadedProducts) || WP.Woo.allLoadedProducts.length === 0) {
            el.innerHTML = '<div class="empty-state"><h3>No products found</h3></div>';
            return;
        }

        const isBasic = WP.Woo.isBasicMode();

        el.innerHTML =
            '<table class="data-table">' +
                '<thead><tr>' +
                    '<th></th><th>Name</th><th>SKU</th><th>Price</th><th>Stock</th><th>Status</th>' +
                    (isBasic ? '' : '<th>Actions</th>') +
                '</tr></thead>' +
                '<tbody>' +
                    WP.Woo.allLoadedProducts.map(function(p) {
                        var img = p.images && p.images[0] ? p.images[0].src : '';
                        var statusCls = p.status === 'publish' ? 'badge-green' : 'badge-orange';
                        var stockCls = p.stock_status === 'instock' ? 'badge-green' :
                                       p.stock_status === 'outofstock' ? 'badge-red' : 'badge-orange';
                        return '<tr>' +
                            '<td>' + (img ? '<img src="' + WP.stripHtml(img) + '" style="width:40px;height:40px;object-fit:cover;border-radius:4px" onerror="this.style.display=\'none\'">' : '') + '</td>' +
                            '<td style="font-weight:500;cursor:pointer" onclick="WP.Woo.showProductModal(' + p.id + ')">' + WP.stripHtml(p.name || '') + '</td>' +
                            '<td style="color:var(--text-muted)">' + WP.stripHtml(p.sku || '--') + '</td>' +
                            '<td>$' + WP.stripHtml(p.price || '0') + '</td>' +
                            '<td><span class="badge ' + stockCls + '">' + (p.stock_status || 'unknown') + '</span></td>' +
                            '<td><span class="badge ' + statusCls + '">' + p.status + '</span></td>' +
                            (isBasic ? '' :
                                '<td>' +
                                    '<button class="btn-sm" onclick="WP.Woo.showProductModal(' + p.id + ')" title="Edit">&#9998;</button> ' +
                                    '<button class="btn-sm" onclick="WP.Woo.deleteProduct(' + p.id + ',\'' + WP.stripHtml(p.name || '').replace(/'/g, "\\'") + '\')" title="Delete" style="color:var(--red)">&#128465;</button>' +
                                '</td>'
                            ) +
                        '</tr>';
                    }).join('') +
                '</tbody>' +
            '</table>' +
            '<div class="pagination">' +
                '<button id="load-more-btn" class="btn btn-primary" style="margin-top:20px;width:100%" onclick="WP.Woo.loadMoreProducts()">Load More</button>' +
            '</div>';
    },

    async loadMoreProducts() {
        var btn = document.getElementById('load-more-btn');
        if (!btn) return;
        btn.disabled = true;
        btn.textContent = 'Loading...';

        try {
            var result = await WP.api('sites/' + WP.currentSite.id + '/woo/products?page=' + WP.Woo.productsPage + '&per_page=20');
            var newProducts = result.data || [];

            if (newProducts.length === 0) {
                btn.textContent = 'No more products';
                btn.disabled = true;
                return;
            }

            WP.Woo.allLoadedProducts = WP.Woo.allLoadedProducts.concat(newProducts);
            WP.Woo.productsPage++;
            WP.Woo.renderProductsTable();
        } catch (e) {
            btn.textContent = 'Load More';
            btn.disabled = false;
            WP.toast('Failed to load more products: ' + e.message, 'error');
        }
    },

    // ── Product Create / Edit Modal ──────────────────────────

    async showProductModal(productId) {
        var product = null;
        var isEdit = !!productId;
        var title = isEdit ? 'Edit Product' : 'New Product';

        if (isEdit) {
            // Try local cache first, fall back to API
            product = WP.Woo.allLoadedProducts.find(function(p) { return p.id === productId; });
            if (!product) {
                try {
                    var resp = await WP.api('sites/' + WP.currentSite.id + '/woo/products/' + productId);
                    product = resp.data || resp;
                } catch (e) {
                    WP.toast('Failed to load product: ' + e.message, 'error');
                    return;
                }
            }
        }

        var backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.id = 'product-modal';
        backdrop.onclick = function(e) { if (e.target === backdrop) backdrop.remove(); };

        backdrop.innerHTML =
            '<div class="modal" style="max-width:640px">' +
                '<h3>' + title + '</h3>' +
                '<div class="form-group">' +
                    '<label>Name</label>' +
                    '<input type="text" class="form-input" id="prod-name" value="' + WP.stripHtml(product ? product.name || '' : '') + '">' +
                '</div>' +
                '<div class="form-row">' +
                    '<div class="form-group">' +
                        '<label>Regular Price</label>' +
                        '<input type="text" class="form-input" id="prod-price" placeholder="29.99" value="' + WP.stripHtml(product ? product.regular_price || '' : '') + '">' +
                    '</div>' +
                    '<div class="form-group">' +
                        '<label>Sale Price</label>' +
                        '<input type="text" class="form-input" id="prod-sale-price" placeholder="" value="' + WP.stripHtml(product ? product.sale_price || '' : '') + '">' +
                    '</div>' +
                '</div>' +
                '<div class="form-row">' +
                    '<div class="form-group">' +
                        '<label>SKU</label>' +
                        '<input type="text" class="form-input" id="prod-sku" value="' + WP.stripHtml(product ? product.sku || '' : '') + '">' +
                    '</div>' +
                    '<div class="form-group">' +
                        '<label>Status</label>' +
                        '<select class="form-input" id="prod-status">' +
                            '<option value="draft"' + (product && product.status === 'draft' ? ' selected' : '') + '>Draft</option>' +
                            '<option value="publish"' + (product && product.status === 'publish' ? ' selected' : '') + '>Published</option>' +
                            '<option value="pending"' + (product && product.status === 'pending' ? ' selected' : '') + '>Pending Review</option>' +
                            '<option value="private"' + (product && product.status === 'private' ? ' selected' : '') + '>Private</option>' +
                        '</select>' +
                    '</div>' +
                '</div>' +
                '<div class="form-row">' +
                    '<div class="form-group">' +
                        '<label class="form-check">' +
                            '<input type="checkbox" id="prod-manage-stock"' + (product && product.manage_stock ? ' checked' : '') + ' onchange="document.getElementById(\'prod-stock-qty-row\').style.display=this.checked?\'\':\'none\'">' +
                            ' Manage Stock' +
                        '</label>' +
                    '</div>' +
                    '<div class="form-group" id="prod-stock-qty-row" style="display:' + (product && product.manage_stock ? '' : 'none') + '">' +
                        '<label>Stock Quantity</label>' +
                        '<input type="number" class="form-input" id="prod-stock-qty" value="' + (product ? product.stock_quantity || '' : '') + '">' +
                    '</div>' +
                '</div>' +
                '<div class="form-group">' +
                    '<label>Short Description</label>' +
                    '<textarea class="form-input" id="prod-desc" rows="3">' + WP.stripHtml(product ? product.short_description || '' : '') + '</textarea>' +
                '</div>' +
                '<div class="modal-actions">' +
                    '<button class="btn btn-ghost" onclick="document.getElementById(\'product-modal\').remove()">Cancel</button>' +
                    '<button class="btn btn-woo" onclick="WP.Woo.saveProduct(' + (isEdit ? productId : 'null') + ')">' + (isEdit ? 'Save Changes' : 'Create') + '</button>' +
                '</div>' +
            '</div>';

        document.body.appendChild(backdrop);
    },

    async saveProduct(productId) {
        var body = {
            name: document.getElementById('prod-name').value.trim(),
            regular_price: document.getElementById('prod-price').value.trim() || undefined,
            sale_price: document.getElementById('prod-sale-price').value.trim() || undefined,
            sku: document.getElementById('prod-sku').value.trim() || undefined,
            short_description: document.getElementById('prod-desc').value.trim() || undefined,
            status: document.getElementById('prod-status').value,
            manage_stock: document.getElementById('prod-manage-stock').checked,
        };

        if (body.manage_stock) {
            var qty = document.getElementById('prod-stock-qty').value;
            if (qty !== '') body.stock_quantity = parseInt(qty, 10);
        }

        if (!body.name) { WP.toast('Name is required', 'error'); return; }

        try {
            if (productId) {
                await WP.api('sites/' + WP.currentSite.id + '/woo/products/' + productId, { method: 'PUT', body: body });
                WP.toast('Product updated!');
            } else {
                await WP.api('sites/' + WP.currentSite.id + '/woo/products', { method: 'POST', body: body });
                WP.toast('Product created!');
            }
            document.getElementById('product-modal').remove();
            WP.Woo.renderProducts(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Save failed: ' + e.message, 'error');
        }
    },

    async deleteProduct(productId, name) {
        if (!confirm('Delete "' + name + '"? This will move it to the trash.')) return;
        try {
            await WP.api('sites/' + WP.currentSite.id + '/woo/products/' + productId, { method: 'DELETE' });
            WP.toast('Product deleted');
            WP.Woo.allLoadedProducts = WP.Woo.allLoadedProducts.filter(function(p) { return p.id !== productId; });
            WP.Woo.renderProductsTable();
        } catch (e) {
            WP.toast('Delete failed: ' + e.message, 'error');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  ORDERS
    // ═══════════════════════════════════════════════════════════

    orderStatuses: [
        { value: '', label: 'All' },
        { value: 'pending', label: 'Pending' },
        { value: 'processing', label: 'Processing' },
        { value: 'on-hold', label: 'On Hold' },
        { value: 'completed', label: 'Completed' },
        { value: 'cancelled', label: 'Cancelled' },
        { value: 'refunded', label: 'Refunded' },
        { value: 'failed', label: 'Failed' },
    ],

    statusColors: {
        'processing': 'badge-blue', 'completed': 'badge-green',
        'on-hold': 'badge-orange', 'cancelled': 'badge-red',
        'refunded': 'badge-red', 'pending': 'badge-orange',
        'failed': 'badge-red',
    },

    async renderOrders(main) {
        if (!WP.requireSite(main)) return;
        if (!WP.currentSite.is_woocommerce) {
            main.innerHTML = '<div class="empty-state"><h3>WooCommerce not enabled</h3></div>';
            return;
        }

        var status = await WP.Woo.checkStatus();
        if (WP.Woo.isBasicMode()) {
            WP.Woo.keysRequiredPage(main, 'Orders', '&#128230;', 'Orders');
            return;
        }

        var statusTabs = WP.Woo.orderStatuses.map(function(s) {
            var active = WP.Woo.ordersStatus === s.value ? ' active' : '';
            return '<button class="tab-btn' + active + '" onclick="WP.Woo.filterOrders(\'' + s.value + '\')">' + s.label + '</button>';
        }).join('');

        main.innerHTML =
            '<div class="main-header">' +
                '<h2>Orders — ' + WP.stripHtml(WP.currentSite.name) + '</h2>' +
            '</div>' +
            '<div class="search-bar" style="margin-bottom:12px;display:flex;gap:8px">' +
                '<input type="text" class="form-input" id="orders-search" placeholder="Search orders (ID, customer, email...)"' +
                '       value="' + WP.stripHtml(WP.Woo.ordersSearch) + '"' +
                '       onkeydown="if(event.key===\'Enter\')WP.Woo.doSearchOrders()"' +
                '       style="flex:1">' +
                '<button class="btn btn-primary" onclick="WP.Woo.doSearchOrders()">Search</button>' +
                (WP.Woo.ordersSearch ? '<button class="btn btn-ghost" onclick="WP.Woo.clearOrdersSearch()">Clear</button>' : '') +
            '</div>' +
            '<div class="tab-bar" style="margin-bottom:16px">' + statusTabs + '</div>' +
            '<div id="orders-content"><div class="spinner" style="margin:40px auto"></div></div>';

        await WP.Woo.loadOrders();
    },

    async loadOrders() {
        var el = document.getElementById('orders-content');
        if (!el) return;
        el.innerHTML = '<div class="spinner" style="margin:40px auto"></div>';

        try {
            var params = 'page=' + WP.Woo.ordersPage + '&per_page=20';
            if (WP.Woo.ordersSearch) params += '&search=' + encodeURIComponent(WP.Woo.ordersSearch);
            if (WP.Woo.ordersStatus) params += '&status=' + WP.Woo.ordersStatus;

            var result = await WP.api('sites/' + WP.currentSite.id + '/woo/orders?' + params);
            var orders = result.data || [];

            if (!Array.isArray(orders) || orders.length === 0) {
                el.innerHTML = '<div class="empty-state"><h3>No orders found</h3></div>';
                return;
            }

            el.innerHTML =
                '<table class="data-table">' +
                    '<thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Items</th><th>Total</th><th>Date</th><th>Actions</th></tr></thead>' +
                    '<tbody>' +
                        orders.map(function(o) {
                            var customer = o.billing ? (o.billing.first_name || '') + ' ' + (o.billing.last_name || '') : '';
                            var itemCount = o.line_items ? o.line_items.length : 0;
                            return '<tr style="cursor:pointer" onclick="WP.Woo.showOrderDetail(' + o.id + ')">' +
                                '<td style="font-weight:500">#' + (o.id || o.number) + '</td>' +
                                '<td>' + WP.stripHtml(customer.trim() || 'Guest') + '</td>' +
                                '<td><span class="badge ' + (WP.Woo.statusColors[o.status] || 'badge-blue') + '">' + o.status + '</span></td>' +
                                '<td style="color:var(--text-muted)">' + itemCount + ' item' + (itemCount !== 1 ? 's' : '') + '</td>' +
                                '<td>' + (o.currency_symbol || '$') + (o.total || '0') + '</td>' +
                                '<td>' + WP.formatDate(o.date_created) + '</td>' +
                                '<td><button class="btn-sm" onclick="event.stopPropagation();WP.Woo.showOrderDetail(' + o.id + ')" title="View">&#128065;</button></td>' +
                            '</tr>';
                        }).join('') +
                    '</tbody>' +
                '</table>';
        } catch (e) {
            el.innerHTML = '<p style="color:var(--red)">Failed to load orders: ' + e.message + '</p>';
        }
    },

    doSearchOrders() {
        WP.Woo.ordersSearch = document.getElementById('orders-search').value.trim();
        WP.Woo.ordersPage = 1;
        WP.Woo.renderOrders(document.getElementById('main-content'));
    },

    clearOrdersSearch() {
        WP.Woo.ordersSearch = '';
        WP.Woo.ordersPage = 1;
        WP.Woo.renderOrders(document.getElementById('main-content'));
    },

    filterOrders(status) {
        WP.Woo.ordersStatus = status;
        WP.Woo.ordersPage = 1;
        WP.Woo.loadOrders();
        // Update active tab
        document.querySelectorAll('.tab-bar .tab-btn').forEach(function(btn) {
            btn.classList.remove('active');
        });
        event.target.classList.add('active');
    },

    // ── Order Detail Modal ───────────────────────────────────

    async showOrderDetail(orderId) {
        var backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.id = 'order-detail-modal';
        backdrop.onclick = function(e) { if (e.target === backdrop) backdrop.remove(); };
        backdrop.innerHTML = '<div class="modal" style="max-width:720px"><div class="spinner" style="margin:40px auto"></div></div>';
        document.body.appendChild(backdrop);

        try {
            var resp = await WP.api('sites/' + WP.currentSite.id + '/woo/orders/' + orderId);
            var o = resp.data || resp;

            var billing = o.billing || {};
            var shipping = o.shipping || {};
            var items = o.line_items || [];

            var statusOpts = WP.Woo.orderStatuses.filter(function(s) { return s.value; }).map(function(s) {
                return '<option value="' + s.value + '"' + (o.status === s.value ? ' selected' : '') + '>' + s.label + '</option>';
            }).join('');

            var itemsHtml = items.map(function(li) {
                return '<tr>' +
                    '<td>' + WP.stripHtml(li.name || '') + (li.sku ? ' <span style="color:var(--text-muted);font-size:11px">(' + WP.stripHtml(li.sku) + ')</span>' : '') + '</td>' +
                    '<td style="text-align:center">' + (li.quantity || 0) + '</td>' +
                    '<td style="text-align:right">$' + (li.total || '0') + '</td>' +
                '</tr>';
            }).join('');

            var noteHtml = '';
            if (o.customer_note) {
                noteHtml = '<div class="callout callout-info" style="margin-top:16px">' +
                    '<span class="callout-icon">&#128172;</span>' +
                    '<div><strong>Customer Note:</strong> ' + WP.stripHtml(o.customer_note) + '</div>' +
                '</div>';
            }

            var modal = backdrop.querySelector('.modal');
            modal.innerHTML =
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
                    '<h3 style="margin:0">Order #' + (o.number || o.id) + '</h3>' +
                    '<span class="badge ' + (WP.Woo.statusColors[o.status] || 'badge-blue') + '" style="font-size:13px;padding:4px 12px">' + o.status + '</span>' +
                '</div>' +

                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">' +
                    '<div style="background:var(--bg);padding:12px;border-radius:8px">' +
                        '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px">Billing</div>' +
                        '<div style="font-weight:500">' + WP.stripHtml((billing.first_name || '') + ' ' + (billing.last_name || '')) + '</div>' +
                        (billing.email ? '<div style="font-size:12px;color:var(--text-muted)">' + WP.stripHtml(billing.email) + '</div>' : '') +
                        (billing.phone ? '<div style="font-size:12px;color:var(--text-muted)">' + WP.stripHtml(billing.phone) + '</div>' : '') +
                        (billing.address_1 ? '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">' +
                            WP.stripHtml(billing.address_1) + '<br>' +
                            WP.stripHtml((billing.city || '') + ', ' + (billing.state || '') + ' ' + (billing.postcode || '')) +
                        '</div>' : '') +
                    '</div>' +
                    '<div style="background:var(--bg);padding:12px;border-radius:8px">' +
                        '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px">Shipping</div>' +
                        '<div style="font-weight:500">' + WP.stripHtml((shipping.first_name || '') + ' ' + (shipping.last_name || '')) + '</div>' +
                        (shipping.address_1 ? '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">' +
                            WP.stripHtml(shipping.address_1) + '<br>' +
                            WP.stripHtml((shipping.city || '') + ', ' + (shipping.state || '') + ' ' + (shipping.postcode || '')) +
                        '</div>' : '<div style="font-size:12px;color:var(--text-muted)">Same as billing</div>') +
                    '</div>' +
                '</div>' +

                '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px">Line Items</div>' +
                '<table class="data-table" style="margin-bottom:12px">' +
                    '<thead><tr><th>Product</th><th style="text-align:center">Qty</th><th style="text-align:right">Total</th></tr></thead>' +
                    '<tbody>' + itemsHtml + '</tbody>' +
                    '<tfoot>' +
                        (o.discount_total && o.discount_total !== '0.00' ? '<tr><td colspan="2" style="text-align:right;color:var(--text-muted)">Discount</td><td style="text-align:right">-$' + o.discount_total + '</td></tr>' : '') +
                        (o.shipping_total && o.shipping_total !== '0.00' ? '<tr><td colspan="2" style="text-align:right;color:var(--text-muted)">Shipping</td><td style="text-align:right">$' + o.shipping_total + '</td></tr>' : '') +
                        (o.total_tax && o.total_tax !== '0.00' ? '<tr><td colspan="2" style="text-align:right;color:var(--text-muted)">Tax</td><td style="text-align:right">$' + o.total_tax + '</td></tr>' : '') +
                        '<tr style="font-weight:600"><td colspan="2" style="text-align:right">Total</td><td style="text-align:right">' + (o.currency_symbol || '$') + o.total + '</td></tr>' +
                    '</tfoot>' +
                '</table>' +

                noteHtml +

                '<div style="display:flex;gap:12px;align-items:center;margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">' +
                    '<label style="font-size:13px;white-space:nowrap">Update Status:</label>' +
                    '<select class="form-input" id="order-status-select" style="flex:1">' + statusOpts + '</select>' +
                    '<button class="btn btn-woo" onclick="WP.Woo.updateOrderStatus(' + o.id + ')">Update</button>' +
                '</div>' +

                '<div class="modal-actions" style="margin-top:12px">' +
                    '<button class="btn btn-ghost" onclick="document.getElementById(\'order-detail-modal\').remove()">Close</button>' +
                '</div>';

        } catch (e) {
            var modal = backdrop.querySelector('.modal');
            modal.innerHTML = '<p style="color:var(--red);padding:20px">Failed to load order: ' + e.message + '</p>' +
                '<div class="modal-actions"><button class="btn btn-ghost" onclick="document.getElementById(\'order-detail-modal\').remove()">Close</button></div>';
        }
    },

    async updateOrderStatus(orderId) {
        var newStatus = document.getElementById('order-status-select').value;
        try {
            await WP.api('sites/' + WP.currentSite.id + '/woo/orders/' + orderId, {
                method: 'PUT',
                body: { status: newStatus }
            });
            WP.toast('Order updated to ' + newStatus);
            document.getElementById('order-detail-modal').remove();
            WP.Woo.loadOrders();
        } catch (e) {
            WP.toast('Update failed: ' + e.message, 'error');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  CUSTOMERS
    // ═══════════════════════════════════════════════════════════

    async renderCustomers(main) {
        if (!WP.requireSite(main)) return;
        if (!WP.currentSite.is_woocommerce) {
            main.innerHTML = '<div class="empty-state"><h3>WooCommerce not enabled</h3></div>';
            return;
        }

        var status = await WP.Woo.checkStatus();
        if (WP.Woo.isBasicMode()) {
            WP.Woo.keysRequiredPage(main, 'Customers', '&#128100;', 'Customer');
            return;
        }

        main.innerHTML =
            '<div class="main-header">' +
                '<h2>Customers — ' + WP.stripHtml(WP.currentSite.name) + '</h2>' +
            '</div>' +
            '<div class="search-bar" style="margin-bottom:16px;display:flex;gap:8px">' +
                '<input type="text" class="form-input" id="customers-search" placeholder="Search customers..."' +
                '       value="' + WP.stripHtml(WP.Woo.customersSearch) + '"' +
                '       onkeydown="if(event.key===\'Enter\')WP.Woo.doSearchCustomers()"' +
                '       style="flex:1">' +
                '<button class="btn btn-primary" onclick="WP.Woo.doSearchCustomers()">Search</button>' +
                (WP.Woo.customersSearch ? '<button class="btn btn-ghost" onclick="WP.Woo.clearCustomersSearch()">Clear</button>' : '') +
            '</div>' +
            '<div id="customers-content"><div class="spinner" style="margin:40px auto"></div></div>';

        await WP.Woo.loadCustomers();
    },

    async loadCustomers() {
        var el = document.getElementById('customers-content');
        if (!el) return;
        el.innerHTML = '<div class="spinner" style="margin:40px auto"></div>';

        try {
            var params = 'per_page=20&page=' + WP.Woo.customersPage;
            if (WP.Woo.customersSearch) params += '&search=' + encodeURIComponent(WP.Woo.customersSearch);

            var result = await WP.api('sites/' + WP.currentSite.id + '/woo/customers?' + params);
            var customers = result.data || [];

            if (!Array.isArray(customers) || customers.length === 0) {
                el.innerHTML = '<div class="empty-state"><h3>No customers found</h3></div>';
                return;
            }

            el.innerHTML =
                '<table class="data-table">' +
                    '<thead><tr><th>Customer</th><th>Email</th><th>Orders</th><th>Total Spent</th><th>Registered</th><th>Actions</th></tr></thead>' +
                    '<tbody>' +
                        customers.map(function(c) {
                            var name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || 'Guest';
                            var avatar = c.avatar_url ? '<img src="' + WP.stripHtml(c.avatar_url) + '" style="width:28px;height:28px;border-radius:50%;margin-right:8px;vertical-align:middle" onerror="this.style.display=\'none\'">' : '';
                            return '<tr style="cursor:pointer" onclick="WP.Woo.showCustomerDetail(' + c.id + ')">' +
                                '<td style="font-weight:500">' + avatar + WP.stripHtml(name) + '</td>' +
                                '<td style="color:var(--text-muted)">' + WP.stripHtml(c.email || '') + '</td>' +
                                '<td>' + (c.orders_count || 0) + '</td>' +
                                '<td>$' + WP.stripHtml(c.total_spent || '0') + '</td>' +
                                '<td style="color:var(--text-muted)">' + (c.date_created ? WP.formatDate(c.date_created) : '--') + '</td>' +
                                '<td><button class="btn-sm" onclick="event.stopPropagation();WP.Woo.showCustomerDetail(' + c.id + ')" title="View">&#128065;</button></td>' +
                            '</tr>';
                        }).join('') +
                    '</tbody>' +
                '</table>';
        } catch (e) {
            el.innerHTML = '<p style="color:var(--red)">Failed to load customers: ' + e.message + '</p>';
        }
    },

    doSearchCustomers() {
        WP.Woo.customersSearch = document.getElementById('customers-search').value.trim();
        WP.Woo.customersPage = 1;
        WP.Woo.loadCustomers();
    },

    clearCustomersSearch() {
        WP.Woo.customersSearch = '';
        WP.Woo.customersPage = 1;
        WP.Woo.renderCustomers(document.getElementById('main-content'));
    },

    // ── Customer Detail Modal ────────────────────────────────

    async showCustomerDetail(customerId) {
        var backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.id = 'customer-detail-modal';
        backdrop.onclick = function(e) { if (e.target === backdrop) backdrop.remove(); };
        backdrop.innerHTML = '<div class="modal" style="max-width:720px"><div class="spinner" style="margin:40px auto"></div></div>';
        document.body.appendChild(backdrop);

        try {
            // Load customer and their orders in parallel
            var custPromise = WP.api('sites/' + WP.currentSite.id + '/woo/customers/' + customerId);
            var ordersPromise = WP.api('sites/' + WP.currentSite.id + '/woo/customers/' + customerId + '/orders?per_page=10');
            var results = await Promise.all([custPromise, ordersPromise]);

            var c = results[0].data || results[0];
            var orders = (results[1].data || []);

            var billing = c.billing || {};
            var name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || 'Customer #' + c.id;
            var avatar = c.avatar_url ? '<img src="' + WP.stripHtml(c.avatar_url) + '" style="width:48px;height:48px;border-radius:50%;margin-right:16px" onerror="this.style.display=\'none\'">' : '';

            var ordersHtml = '';
            if (orders.length > 0) {
                ordersHtml = '<table class="data-table">' +
                    '<thead><tr><th>Order</th><th>Status</th><th>Total</th><th>Date</th></tr></thead>' +
                    '<tbody>' +
                        orders.map(function(o) {
                            return '<tr style="cursor:pointer" onclick="document.getElementById(\'customer-detail-modal\').remove();WP.Woo.showOrderDetail(' + o.id + ')">' +
                                '<td style="font-weight:500">#' + (o.number || o.id) + '</td>' +
                                '<td><span class="badge ' + (WP.Woo.statusColors[o.status] || 'badge-blue') + '">' + o.status + '</span></td>' +
                                '<td>' + (o.currency_symbol || '$') + (o.total || '0') + '</td>' +
                                '<td>' + WP.formatDate(o.date_created) + '</td>' +
                            '</tr>';
                        }).join('') +
                    '</tbody>' +
                '</table>';
            } else {
                ordersHtml = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0">No orders yet</div>';
            }

            var modal = backdrop.querySelector('.modal');
            modal.innerHTML =
                '<div style="display:flex;align-items:center;margin-bottom:20px">' +
                    avatar +
                    '<div>' +
                        '<h3 style="margin:0">' + WP.stripHtml(name) + '</h3>' +
                        (c.email ? '<div style="color:var(--text-muted);font-size:13px">' + WP.stripHtml(c.email) + '</div>' : '') +
                    '</div>' +
                '</div>' +

                '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">' +
                    '<div style="background:var(--bg);padding:12px;border-radius:8px;text-align:center">' +
                        '<div style="font-size:24px;font-weight:600">' + (c.orders_count || 0) + '</div>' +
                        '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Orders</div>' +
                    '</div>' +
                    '<div style="background:var(--bg);padding:12px;border-radius:8px;text-align:center">' +
                        '<div style="font-size:24px;font-weight:600">$' + WP.stripHtml(c.total_spent || '0') + '</div>' +
                        '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Total Spent</div>' +
                    '</div>' +
                    '<div style="background:var(--bg);padding:12px;border-radius:8px;text-align:center">' +
                        '<div style="font-size:24px;font-weight:600">' + (c.orders_count > 0 ? '$' + (parseFloat(c.total_spent || 0) / c.orders_count).toFixed(2) : '--') + '</div>' +
                        '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Avg Order</div>' +
                    '</div>' +
                '</div>' +

                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">' +
                    '<div style="background:var(--bg);padding:12px;border-radius:8px">' +
                        '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px">Contact</div>' +
                        (billing.phone ? '<div style="font-size:13px">&#128222; ' + WP.stripHtml(billing.phone) + '</div>' : '') +
                        (billing.email ? '<div style="font-size:13px">&#128231; ' + WP.stripHtml(billing.email || c.email) + '</div>' : '') +
                        (c.date_created ? '<div style="font-size:12px;color:var(--text-muted);margin-top:6px">Customer since ' + WP.formatDate(c.date_created) + '</div>' : '') +
                    '</div>' +
                    '<div style="background:var(--bg);padding:12px;border-radius:8px">' +
                        '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px">Address</div>' +
                        (billing.address_1 ?
                            '<div style="font-size:13px">' + WP.stripHtml(billing.address_1) + '</div>' +
                            '<div style="font-size:13px">' + WP.stripHtml((billing.city || '') + ', ' + (billing.state || '') + ' ' + (billing.postcode || '')) + '</div>' +
                            (billing.country ? '<div style="font-size:12px;color:var(--text-muted)">' + WP.stripHtml(billing.country) + '</div>' : '')
                        : '<div style="font-size:13px;color:var(--text-muted)">No address on file</div>') +
                    '</div>' +
                '</div>' +

                '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px">Recent Orders</div>' +
                ordersHtml +

                '<div class="modal-actions" style="margin-top:16px">' +
                    '<button class="btn btn-ghost" onclick="document.getElementById(\'customer-detail-modal\').remove()">Close</button>' +
                '</div>';

        } catch (e) {
            var modal = backdrop.querySelector('.modal');
            modal.innerHTML = '<p style="color:var(--red);padding:20px">Failed to load customer: ' + e.message + '</p>' +
                '<div class="modal-actions"><button class="btn btn-ghost" onclick="document.getElementById(\'customer-detail-modal\').remove()">Close</button></div>';
        }
    },
};
