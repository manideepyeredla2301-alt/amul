import { PlatformError, json, text } from './platform-core.js';
import { principal, requirePermission, staffLogin, staffLogout, staffSession } from './platform-auth.js';
import { catalog, categoriesRoute, deleteImage, importProducts, itemFromRow, optionGroupsRoute, productsRoute, serveImage, uploadImage } from './platform-catalog.js';
import { createOrder, holdsRoute, listOrders, orderDetails, orderEvents, receipt, recordPayment, refundPayment, returnItems, setOrderStatus, trackOrder } from './platform-orders.js';
import { ingredientsRoute, inventory, overview, promotionsRoute, publicQr, qrRoute, recipeRoute, reports, settingsRoute, staffRoute, stockAdjustment } from './platform-ops.js';

async function dispatch(request,env) {
  const url=new URL(request.url),path=url.pathname,method=request.method;
  if (path==='/api/cafe/menu'&&method==='GET') return json(await catalog(env,'qr'));
  if (path==='/api/cafe/orders'&&method==='POST') return createOrder(request,env);
  const tracking=path.match(/^\/api\/cafe\/orders\/([a-f0-9]{48})$/i);
  if (tracking&&method==='GET') return trackOrder(tracking[1],env);
  const publicCode=path.match(/^\/api\/cafe\/qr\/([a-z0-9-]{2,80})$/);
  if (publicCode&&method==='GET') return publicQr(env,publicCode[1]);
  const image=path.match(/^\/api\/cafe\/images\/([a-f0-9]{32})$/i);
  if (image&&method==='GET') return serveImage(env,image[1]);

  if (path==='/api/cafe/staff/login'&&method==='POST') return staffLogin(request,env);
  if (path==='/api/cafe/staff/logout'&&method==='POST') return staffLogout(request,env);
  if (path==='/api/cafe/staff/session'&&method==='GET') return staffSession(request,env);
  if (path==='/api/cafe/admin/session'&&method==='GET') return staffSession(request,env);

  if (!path.startsWith('/api/cafe/pos/')&&!path.startsWith('/api/cafe/admin/')) return null;
  const user=await principal(request,env);

  if (path==='/api/cafe/pos/catalog'&&method==='GET') {
    requirePermission(user,'pos'); return json(await catalog(env,'pos'));
  }
  if (path==='/api/cafe/pos/lookup'&&method==='GET') {
    requirePermission(user,'pos');
    const barcode=text(url.searchParams.get('barcode'),'barcode',80);
    const row=await env.DB.prepare('SELECT * FROM cafe_products WHERE barcode=?1 AND active=1').bind(barcode).first();
    if (!row) throw new PlatformError('Barcode not found',404);
    const {cost_paise,stock_quantity,low_stock_threshold,prep_steps,...product}=itemFromRow(row);
    return json({product});
  }
  if (path==='/api/cafe/pos/orders'&&method==='POST') return createOrder(request,env,user,'TABLET');
  if (path==='/api/cafe/pos/orders'&&method==='GET') { requirePermission(user,'orders'); return listOrders(env,{kitchenOnly:false}); }
  const posOrder=path.match(/^\/api\/cafe\/pos\/orders\/([a-f0-9-]{36})$/i);
  if (posOrder&&method==='GET') return orderDetails(env,user,posOrder[1]);
  const posPayment=path.match(/^\/api\/cafe\/pos\/orders\/([a-f0-9-]{36})\/payments$/i);
  if (posPayment&&method==='POST') return recordPayment(request,env,user,posPayment[1]);
  const posReceipt=path.match(/^\/api\/cafe\/pos\/orders\/([a-f0-9-]{36})\/receipt$/i);
  if (posReceipt&&method==='GET') return receipt(request,env,user,posReceipt[1]);
  const posReturn=path.match(/^\/api\/cafe\/pos\/orders\/([a-f0-9-]{36})\/returns$/i);
  if (posReturn&&method==='POST') return returnItems(request,env,user,posReturn[1]);
  if (path==='/api/cafe/pos/holds'&&['GET','POST'].includes(method)) return holdsRoute(request,env,user,null);
  const hold=path.match(/^\/api\/cafe\/pos\/holds\/([a-f0-9-]{36})$/i);
  if (hold&&method==='DELETE') return holdsRoute(request,env,user,hold[1]);

  if (path==='/api/cafe/admin/orders'&&method==='GET') {
    requirePermission(user,url.searchParams.get('scope')==='all'?'orders':'kitchen');
    return listOrders(env,{kitchenOnly:url.searchParams.get('scope')!=='all'});
  }
  const adminStatus=path.match(/^\/api\/cafe\/admin\/orders\/([a-f0-9-]{36})\/status$/i);
  if (adminStatus&&method==='POST') return setOrderStatus(request,env,user,adminStatus[1]);
  if (path==='/api/cafe/admin/events'&&method==='GET') return orderEvents(request,env,user);
  const adminPayment=path.match(/^\/api\/cafe\/admin\/orders\/([a-f0-9-]{36})\/payments$/i);
  if (adminPayment&&method==='POST') return recordPayment(request,env,user,adminPayment[1]);
  const adminOrder=path.match(/^\/api\/cafe\/admin\/orders\/([a-f0-9-]{36})$/i);
  if (adminOrder&&method==='GET') return orderDetails(env,user,adminOrder[1]);
  const adminReturn=path.match(/^\/api\/cafe\/admin\/orders\/([a-f0-9-]{36})\/returns$/i);
  if (adminReturn&&method==='POST') return returnItems(request,env,user,adminReturn[1]);
  const adminReceipt=path.match(/^\/api\/cafe\/admin\/orders\/([a-f0-9-]{36})\/receipt$/i);
  if (adminReceipt&&method==='GET') return receipt(request,env,user,adminReceipt[1]);
  const adminRefund=path.match(/^\/api\/cafe\/admin\/payments\/([a-f0-9-]{36})\/refunds$/i);
  if (adminRefund&&method==='POST') return refundPayment(request,env,user,adminRefund[1]);
  if (path==='/api/cafe/admin/overview'&&method==='GET') return overview(request,env,user);
  if (path==='/api/cafe/admin/reports'&&method==='GET') return reports(request,env,user);

  if (path==='/api/cafe/admin/categories'||path.startsWith('/api/cafe/admin/categories/'))
    return categoriesRoute(request,env,user,path.slice('/api/cafe/admin/categories/'.length).split('/').filter(Boolean));
  if (path==='/api/cafe/admin/products/import'&&method==='POST') return importProducts(request,env,user);
  if (path==='/api/cafe/admin/products'||path.startsWith('/api/cafe/admin/products/'))
    return productsRoute(request,env,user,path.slice('/api/cafe/admin/products/'.length).split('/').filter(Boolean));
  if (path==='/api/cafe/admin/option-groups'||path.startsWith('/api/cafe/admin/option-groups/'))
    return optionGroupsRoute(request,env,user,path.slice('/api/cafe/admin/option-groups/'.length).split('/').filter(Boolean));
  if (path==='/api/cafe/admin/images'&&method==='POST') return uploadImage(request,env,user);
  const deleteImageMatch=path.match(/^\/api\/cafe\/admin\/images\/([a-f0-9]{32})$/i);
  if (deleteImageMatch&&method==='DELETE') return deleteImage(request,env,user,deleteImageMatch[1]);
  if (path==='/api/cafe/admin/inventory'&&method==='GET') return inventory(request,env,user);
  const adjust=path.match(/^\/api\/cafe\/admin\/inventory\/([a-z0-9-]{2,80})\/adjustments$/);
  if (adjust&&method==='POST') return stockAdjustment(request,env,user,adjust[1]);
  if (path==='/api/cafe/admin/ingredients'||path.startsWith('/api/cafe/admin/ingredients/'))
    return ingredientsRoute(request,env,user,path.slice('/api/cafe/admin/ingredients/'.length).split('/').filter(Boolean)[0]);
  const recipe=path.match(/^\/api\/cafe\/admin\/recipes\/([a-z0-9-]{2,80})$/);
  if (recipe&&['GET','PUT'].includes(method)) return recipeRoute(request,env,user,recipe[1]);
  if (path==='/api/cafe/admin/staff'||path.startsWith('/api/cafe/admin/staff/'))
    return staffRoute(request,env,user,path.slice('/api/cafe/admin/staff/'.length).split('/').filter(Boolean)[0]);
  if (path==='/api/cafe/admin/settings'&&['GET','PUT'].includes(method)) return settingsRoute(request,env,user);
  if (path==='/api/cafe/admin/promotions'||path.startsWith('/api/cafe/admin/promotions/'))
    return promotionsRoute(request,env,user,path.slice('/api/cafe/admin/promotions/'.length).split('/').filter(Boolean)[0]);
  if (path==='/api/cafe/admin/qr'||path.startsWith('/api/cafe/admin/qr/'))
    return qrRoute(request,env,user,path.slice('/api/cafe/admin/qr/'.length).split('/').filter(Boolean)[0]);
  return null;
}

export async function platformRoute(request,env) {
  try { return await dispatch(request,env); }
  catch (error) {
    if (error instanceof PlatformError) return json({error:error.message},error.status);
    if (/UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed/i.test(String(error)))
      return json({error:'This change conflicts with an existing record or rule.'},409);
    console.error('Café platform request failed',error);
    return json({error:'Request failed safely. Please try again.'},500);
  }
}
