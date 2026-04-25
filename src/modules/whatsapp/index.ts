/**
 * WhatsApp module — delivery action handlers for group management tools.
 *
 * Registers:
 *   register_group       → wire a WhatsApp JID to an agent group + create folder
 *   get_available_groups → fetch live group list from the WhatsApp adapter
 */
import { registerDeliveryAction } from '../../delivery.js';
import { handleRegisterGroup } from './register-group.js';
import { handleGetAvailableGroups } from './available-groups.js';

registerDeliveryAction('register_group', handleRegisterGroup);
registerDeliveryAction('get_available_groups', handleGetAvailableGroups);
