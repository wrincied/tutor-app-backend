const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const c = require('../controllers/studentController');

router.use(auth);

router.get('/',        c.getAll);
router.get('/:id',     c.getOne);
router.post('/',       c.create);
router.put('/:id',     c.update);
router.delete('/:id',  c.remove);
router.post('/:id/topup', c.topup);

module.exports = router;
